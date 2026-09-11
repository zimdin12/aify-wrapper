# Herdr integration — how it works, and why it is built this way

Two separate things the operator asked for, which need different mechanisms:

1. **Ordinary Herdr keeps aify agents.** Start `claude-aify` or `hermes-aify` in an ordinary Herdr
   pane, restart the machine, and they should come back as `claude-aify` — not as bare `claude`.
2. **`herdr-aify`, an isolated instance.** One command that owns its own Herdr, runs the actual
   dedicated `aify-env` daemon in its first space, lets that daemon open and close the other spaces
   for its workers, and takes the whole tree down when the command exits.

**Stock Herdr 0.9.0, no fork.** A fork was ruled out by the operator, and it is blocked anyway: the
vendored `libghostty-vt` needs Zig 0.15.2 to build, and Herdr's own build prints an external
contributor policy. Everything below uses the published plugin surface.

## Using it

**One install step, once per machine.** Nothing restores until the plugin is linked, and until then
everything else looks like it is working:

```bash
aify-herdr-pane install          # links the plugin into your Herdr
herdr plugin list                # should show: aify.wrappers (aify wrappers) enabled
```

**Then there is nothing to do.** Start `claude-aify` or `hermes-aify` in a Herdr pane as usual. The
wrapper labels its own pane and records the exact command; after a reboot, Herdr restores the session
and runs the plugin's startup hook, which puts each wrapper back into its own pane. Panes running a
bare `claude` or `hermes` keep Herdr's native resume and are not touched.

```bash
aify-herdr-pane status           # what is recorded, and which pane each record is in
aify-herdr-pane restore          # run the restore now instead of waiting for a restart
herdr plugin unlink aify.wrappers   # undo the install
```

**The isolated instance is a separate command**, and it does not need the plugin:

```bash
herdr-aify                       # an isolated Herdr with a dedicated aify-env in its first space
herdr-aify --status              # what previous invocations left on this host
```

Closing `herdr-aify` ends that Herdr, its dedicated env and its workers. A new invocation gets a
fresh UUID and the daemon refuses a context whose receipts already exist, so it cannot resurrect the
previous invocation's agents. Your ordinary Herdr is untouched by it: different socket, different
config and state roots.

**Where things live.** Records: `~/.aify/herdr/panes.json` (`AIFY_HERDR_LEDGER` moves it).
Invocations: `~/.aify/herdr/invocations/<uuid>/`.

## What stock Herdr actually gives us

Read out of `herdr-upstream` at `b99002ac` (v0.9.0), not assumed:

- **`herdr-plugin.toml`** declares `[[actions]]` (user-invokable, scoped by `contexts`), `[[events]]`
  (subscriptions such as `pane.created`), and `[[panes]]` (declared panes with a `placement`). Each
  one runs an arbitrary argv.
- Plugin processes get `HERDR_PLUGIN_ID`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`
  and `HERDR_PLUGIN_CONTEXT_JSON`, and can call back through the `herdr` CLI or its socket.
- The API has ~100 methods, including `plugin.pane.open` (a real PTY from plugin-supplied argv in a
  chosen workspace), `workspace.create` / `workspace.close`, `pane.rename`, `pane.send_text`,
  `pane.list`, `pane.report_agent`, `pane.report_agent_session`, `pane.release_agent`,
  `pane.clear_agent_authority`, and `server.stop`.

## The one thing it does NOT give us, and the lever that replaces it

`agent_resume::plan(source, agent, kind)` is a **hardcoded Rust match**. It produces bare argv —
`["claude", "--resume", "<id>"]` — and there is no configuration, manifest or plugin hook that can
add a case. The `distribution/agent-detection/*.toml` manifests are screen-state rules
(working / idle / blocked); they do not carry launch commands. So "make Herdr resume `claude-aify`"
is genuinely impossible without changing Herdr.

**But it does not have to resume it.** `plan()` is gated by `is_official_agent_source(source, agent)`,
a hardcoded allowlist of pairs like `("herdr:claude", "claude")`. An agent reported under a source
that is not on that list returns `None` — **no resume plan at all**, so that pane restores as a plain
shell instead of relaunching a bare agent.

That is the whole mechanism, and it is precisely selective:

| pane | reports | `plan()` | on restore |
|---|---|---|---|
| bare `claude` | `herdr:claude` (Herdr's own integration) | official → argv | native resume, **unchanged** |
| `claude-aify` | `herdr:aify` / `claude-aify` (ours) | not official → `None` | plain shell, **ours to fill** |

Per-pane, because `agent_session` is persisted per pane in `PaneSnapshot`. Nothing global is
switched off, so bare-native restore keeps working exactly as it does today — which the build
contract requires.

Authority is arbitrated by Herdr itself: `release_agent_with_mutation` refuses a report whose
`source` does not match the pane's current `hook_authority`, and `pane.clear_agent_authority` resets
it. So the wrapper claims authority once and Herdr's own claude hook stops overwriting it. We are
using the mechanism as designed rather than racing it.

## MEASURED, not inferred — the run this design now rests on

Everything above was read out of Herdr's source. On 2026-09-12 it was **driven against a live Herdr
0.9.0** in an isolated profile (`XDG_CONFIG_HOME` / `XDG_STATE_HOME` under a temp root), because a
claim this load-bearing should not ship on a source read. Three panes, one server stop, one restart:

| pane | reported as | in `session.json` after the stop | after the restart |
|---|---|---|---|
| `w1:p1` | `herdr:claude` / `claude` | `agent_session` present | came back **with its agent** |
| `w1:p3` | `herdr:claude` / `claude` (control) | `agent_session` present | came back **with its agent** |
| `w1:p2` | `herdr:aify` / `claude-aify` | `cwd` + `label`, **no `agent_session`** | came back an **empty shell**, label intact |

Two official-source panes persisted a session and the aify-source pane did not, so the asymmetry is
the **source** and not the flags — the control and the subject differed in nothing else. That is the
whole mechanism, and it is now a measurement rather than a reading.

**Three things this run corrected in the notes above.**

1. `session.json` lives under **`XDG_CONFIG_HOME`**, not the state root. Isolation that redirected
   only the state root would have shared the operator's real session file.
2. The six-field list is wrong as a description of what is actually written. For the aify pane
   exactly **two** fields came back: `cwd` and `label`. `label` is the durable handle; nothing else
   survives, so everything else has to live in a ledger of ours.
3. `herdr pane rename <pane> <label>` takes the label **positionally**. Passing `--label` sets the
   label to the literal string `--label …`, which is what happened on the first hand-driven attempt
   and persisted that way into a real `session.json`.

## Proven end to end, 2026-09-12

The lever above is the mechanism; this is the whole feature working, in one run against a real Herdr
with an isolated profile and an isolated ledger. No aify-env was involved, so nothing could reach the
operator's fleet.

A bare-agent pane and a wrapper pane, side by side. The wrapper claimed its own pane exactly as the
template does; the server was stopped and started again, which is a real session restore:

```
before   w1:p1  (bare)     session={"source":"herdr:claude", ... "native-session"}
         w1:p2  (wrapper)  label=aify:claude-aify:29fcd8b604c2   session=null
after    w1:p1             agent=claude   session=<the same one>      <- native resume kept
         w1:p2             agent=None     session=null                <- empty shell, label intact
restore  restored 1 pane(s):  w1:p2 <- echo RESTORED_BY_THE_PLUGIN
pane     PS ...> echo RESTORED_BY_THE_PLUGIN
         RESTORED_BY_THE_PLUGIN
```

The bare pane is the negative control and it is in the same run: the restore pass reported one pane,
not two, and left the natively-resumed pane untouched. That is the contract the operator set —
ordinary Herdr keeps working exactly as it did — measured rather than asserted.

**And this proof was weaker than it looked, which review caught and a later measurement confirmed.**
The replayed argv was `echo RESTORED_BY_THE_PLUGIN`: a single bare token, which is the one shape that
cannot expose quoting. Driven against a real Herdr afterwards, `herdr pane run w1:p1 echo --flag
"be terse"` printed `be` and `terse` on separate lines — `pane run` TYPES its arguments into the
pane's shell and the argument boundary was gone. A wrapper started as
`claude-aify --append-system-prompt "be terse"` would have come back configured differently, silently.
`lib/herdr-replay.mjs` now quotes for the intersection of PowerShell, cmd and bash, and REFUSES
anything outside it rather than typing something that would be wrong in one of them.

**Two other defects of the same family were found by that review and are fixed with the tests that
fail without them.** A live handoff keeps the PTYs while giving the new server no agent report, so
every running aify pane looked empty and would have been typed into — the guard is now the pane's
`terminal_id`, measured to change across a restart. And `pruneTo([])` deleted every record on the
host, which an empty listing (a hook firing before Herdr restored anything) would have reached.

**What is still ASSUMED.** The `herdr-aify` command has not been run end to end, because doing so
starts a real aify-env and starting one is the operator's action: supersession there reaps the
predecessor's workers, and that has taken this fleet down before. Its isolated-Herdr half is proven
(the runs above all used it); its dedicated-daemon half passes in tests and has never been executed.

## How the restore is completed

There is **no plugin metadata on a pane**, and `launch_argv` is only replayed `if was_imported`, so
neither is a place to keep our record. The wrapper therefore labels its pane `aify:<wrapper>:<record>`
and keeps the real record — the exact argv, cwd and workspace — in `~/.aify/herdr/panes.json`.

Herdr runs a plugin's `[[startup]]` hook **once after it restores the session**, and again when a new
server takes over during a live handoff. That is precisely the moment an aify pane exists as an empty
shell, so the hook is where the restore belongs: it lists the panes, matches labels against the
ledger, and relaunches the recorded command into every pane that came back empty.

It cannot race native planning, because native planning has already declined: the pane is an idle
shell and there is nothing to beat.

**The guard that matters is not the match, it is the emptiness.** A pane carrying either an
`agent_session` or a live `agent` is already occupied, and relaunching into it would put two agents
on one terminal — worse than not restoring at all. So a pane qualifies only if it carries a label we
own, that label names a record we hold, and the pane shows no sign of life.

## What a wrapper knows about its own pane

A pane's shell receives `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`,
`HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` — measured from a Windows process inside a real pane. So a
wrapper identifies its own pane with no lookup, and `HERDR_ENV` is what keeps an ordinary terminal
launch from paying for any of this.

An earlier reading of this said a pane's shell gets **no** `HERDR_*` at all. That reading was taken
inside WSL, which passes through only what `WSLENV` names: the variables were real and the instrument
was not.

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` are inherited by pane children, which is exactly why the
`herdr-aify` launcher below must clear them for the agents it starts — otherwise every agent under it
would attach to the isolated Herdr profile instead of its own.

## `herdr-aify`, the isolated instance

The launcher owns the lifetime; `aify-env` owns the workers. That split is the operator's ruling and
matches `docs/AIFY_ENV_BOUNDARY.md`.

```
herdr-aify (aify-wrapper)          owns the lifetime; teardown stops the server
  Herdr server                     isolated: own socket, own XDG config/state roots
    space 1: aify-env daemon       the ACTUAL dedicated daemon, --instance-context
    space N: attached workers      opened by the daemon through the plugin API
```

**It is NOT a Windows Job Object, and that was claimed here before it was built.** A real
kill-on-close Job needs a native addon and this package has no native dependency. What takes the
tree down is the structure instead: the dedicated aify-env runs in a PANE of this Herdr and its
workers are its own children, so stopping this Herdr ends the panes, which ends the env, which ends
the workers. A tree kill is the backstop for a server that will not stop, not the mechanism.

The honest limit: a hard kill of the launcher itself can leave processes behind. What it can never do
is let the NEXT invocation adopt them — that half is enforced by the filesystem, and it is the half
the operator asked for by name.

- The invocation is minted by `lib/herdr-instance.mjs` and authorized by `lib/herdr-owner.mjs`,
  which already exist: the daemon refuses to start until the owner answers its challenge, and a
  dedicated instance cannot supersede or reap the env already serving this machine.
- Isolation uses `XDG_CONFIG_HOME` / `XDG_STATE_HOME`, which `src/config/io.rs` honours on Windows
  before its platform fallback, plus `HERDR_SOCKET_PATH`. Children inherit those, so the launcher
  also exports `AIFY_HERDR_ISOLATED` and the host's original XDG values, and each wrapper puts them
  back before starting its agent — agents keep their real profiles.

  **This sentence used to assert that as done while nothing did it.** The function that looked like
  the mitigation had zero callers, and no wrapper touched XDG at all, so an agent inside a dedicated
  instance inherited the invocation's roots — `codex-aify` wrote its app-server log into a directory
  deleted when the invocation ended. The undo could never have been a function here: the thing that
  starts an agent is the operator typing `claude-aify` into a pane, so it has to be data the shell
  can read. It is now in all four templates, with a control proving an ordinary launch is untouched.
- Ending the command stops the Herdr server, which ends its panes, which ends the dedicated env and
  its workers — **and the stop is verified rather than assumed**: `herdr server stop` returning 0
  says the request was accepted, so the launcher re-probes the socket and reports "confirmed gone" or
  says plainly that the server is still answering. A later invocation mints a fresh UUID, and the
  daemon refuses a context whose receipts already exist, so **no previous invocation's agents can be
  resurrected** — enforced by the filesystem, not by a rule somebody has to remember.

  (An earlier version of this line said "ends the Job". There is no Job object, as this document
  says six paragraphs above; the two statements sat in one file, and the wrong one was the one an
  operator would have read first.)
