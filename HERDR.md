# Herdr integration — how it works, and why it is built this way

Two separate things the operator asked for, which need different mechanisms:

1. **Ordinary Herdr keeps aify agents.** Start `claude-aify` or `hermes-aify` in an ordinary Herdr
   pane, restart the machine, and they should come back as `claude-aify` — not as bare `claude`.
2. **`herdr-aify env`, an isolated instance.** One command that owns its own Herdr, runs the actual
   dedicated `aify-env` daemon in its first space, lets that daemon open and close the other spaces
   for its workers, and takes the whole tree down when the command exits.
3. **`herdr-aify`, this host's own Herdr.** The same command with no argument, and it is deliberately
   the OPPOSITE lifetime: one persistent Herdr with wrapper support and no aify-env at all, for
   resident sessions. Closing it DETACHES; the next launch comes back to the same spaces.

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

**`herdr-aify` is a separate command with TWO modes**, and neither needs the plugin installed by
hand -- the resident links it into its own profile:

```bash
herdr-aify                       # this host's persistent Herdr: residents only, no aify-env
herdr-aify env                   # an isolated Herdr with a dedicated aify-env in its first space
herdr-aify --status              # what previous invocations left on this host
herdr-aify --stop                # end the recorded instance -- or the resident -- from any shell
herdr-aify --prune               # delete what dead invocations left behind
```

**The argument decides the LIFETIME, which is the whole difference between them.** The operator:
"ordinary herdr-aify should remember previous instance agents like ordinary herdr does, that
herdr-aify env is the one that really acts differently. herdr-aify is like ordinary, but supports our
-aify stuff so they could be saved etc." So `env` mints a fresh invocation that dies with the
command, and plain `herdr-aify` uses ONE stable profile under `~/.aify/herdr/resident/` and starts a
server only when nothing answers on its socket.

**Leaving the plain one DETACHES.** Its `herdr server` is started independent -- detached from the
console and unref'd -- so the launcher can exit while the server keeps running, exactly as an
ordinary Herdr does. Both halves were measured on Windows and both were needed: a ref'd child handle
kept the launcher alive after the TUI closed (`main` sets `exitCode` rather than calling `exit`), and
a child sharing the console died with the terminal tab, taking every agent in it. `--stop` is how
you end it on purpose.

**`--prune` is there because every launch mints a directory and nothing removed one.** Twelve had
accumulated in a day of testing, and `--status` — the command you reach for when something is wrong —
prints all of them, so the line you need sinks under the residue of launches that failed weeks ago.
Each invocation is probed on its OWN socket before anything is deleted, so an instance that is still
running keeps its context file and its receipts: those receipts are what stop a later invocation
adopting its workers, and a prune that deleted them would quietly remove the guarantee this whole
design is built on.

**`--stop` exists because of how Windows ends a command.** Only a real console Ctrl-C or a window
close delivers a signal a Node process can handle; a launcher ended any other way leaves its Herdr,
its dedicated aify-env and their panes running, with an owner pointer nobody will clear. `--stop`
reads that pointer, addresses the instance it names and reports whether the server is actually gone.
It is not a workaround for a missing Job object: the pointer names the invocation and the invocation
names the socket, so it can only ever reach the instance this host recorded.

**You do not need `herdr` on your PATH**, and you probably do not have it: Herdr puts itself on the
PATH of the shells IT starts, which is why the bare name resolves inside a Herdr pane and fails at an
ordinary prompt. The launcher looks for `HERDR_BIN_PATH`, then Herdr's own
`~/.herdr/packages/standalone/current`, then the newest release directory, and a refusal names every
place it looked.

Closing `herdr-aify env` ends that Herdr, its dedicated env and its workers. A new invocation gets a
fresh UUID and the daemon refuses a context whose receipts already exist, so it cannot resurrect the
previous invocation's agents. Your ordinary Herdr is untouched by it: different socket, different
config and state roots.

Plain `herdr-aify` is untouched by it too, and by your ordinary Herdr: it has its own socket, its own
XDG roots and **its own pane ledger**. Sharing the default ledger would have had the two sessions
pruning each other's records -- a restore deletes every record whose pane IT cannot see.

**Where things live.** Records: `~/.aify/herdr/panes.json` (`AIFY_HERDR_LEDGER` moves it, and both
`herdr-aify` modes do). Invocations: `~/.aify/herdr/invocations/<uuid>/`. The resident:
`~/.aify/herdr/resident/`.

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

## `herdr-aify` proven end to end, 2026-09-12 — and it did not work until it was run

This section used to say the command had never been executed. It has been now, and the first thing
that happened is the operator ran it and got `spawn herdr ENOENT`. Four defects stood between the
green suite and a working command, and **not one of them was reachable by any test** — each is a fact
about this machine, about Herdr, or about a call site rather than a helper:

1. **`herdr` is not on PATH.** Measured: the install directory is in neither the user nor the system
   registry PATH. Herdr puts itself on the PATH of the shells it starts, so the bare name resolved in
   a developer's Herdr pane and failed at the operator's prompt — the worst possible split, because
   the person testing it cannot see the failure. `lib/herdr-binary.mjs` resolves it properly.
2. **The socket was a named pipe.** It was spelled `\\.\pipe\...` by analogy with aify-env's
   endpoints; Herdr uses a filesystem socket on Windows too and refused it, exiting 1 with
   `PermissionDenied` while the launcher could only report "exited before it was ready".
3. **The daemon's environment went to the wrong process.** `herdr pane run` TYPES a command into a
   shell that already exists, so `AIFY_ADVERTISE=0` handed to the `herdr` CLI never reached the
   daemon. The pane said so: `instance_context: advertisement must be explicitly disabled`. It
   belongs on the SERVER, whose panes inherit it.
4. **The second-launch refusal never fired once.** It read `incumbent?.live`; `profileOwnerState`
   returns `{owned, reason, invocation}` and has never had a `live` field. A green test of that
   helper stayed green while its only caller read a field it does not return.

The run that closes it, with `herdr` deliberately absent from PATH exactly as at the operator's
prompt:

```
start     invocation printed, socket printed, aify-env live in w1:p1 with its TUI rendering
second    "an instance is already running here (invocation 3895f55e-...)"  <- refused
--status  the invocations this host holds, spent flags correct
--stop    "stop accepted, confirmed gone";  herdr.exe count 1 -> 0;  owner pointer cleared
launcher  "the dedicated herdr exited" then
          "stopped (the server had already exited, confirmed gone)"       <- noticed and shut down
```

The last line is itself a fix. It read `stopped (server did not stop, confirmed gone)` — two clauses
from real flags, contradicting each other, describing a teardown that had gone exactly to plan: the
stop request failed BECAUSE the server had already exited. A server that went first is now its own
case, which also stops the backstop reaching for a pid that belongs to whatever Windows issues next.

**What is still ASSUMED.** Nothing about the start, the refusal, the teardown or the output. What has
not been exercised is a dedicated instance running real WORK — agents spawned by that aify-env, doing
something, and dying with it. The teardown mechanism is proven at the Herdr layer (server stops,
panes end, `herdr.exe` reaches zero); that the workers of a busy env go with it is inferred from the
process structure, not measured under load.

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
