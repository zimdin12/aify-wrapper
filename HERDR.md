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
herdr-aify (aify-wrapper)          owns a non-breakaway Windows Job, kill-on-close
  Herdr server                     isolated: own socket, own XDG config/state roots
    space 1: aify-env daemon       the ACTUAL dedicated daemon, --instance-context
    space N: attached workers      opened by the daemon through the plugin API
```

- The invocation is minted by `lib/herdr-instance.mjs` and authorized by `lib/herdr-owner.mjs`,
  which already exist: the daemon refuses to start until the owner answers its challenge, and a
  dedicated instance cannot supersede or reap the env already serving this machine.
- Isolation uses `XDG_CONFIG_HOME` / `XDG_STATE_HOME`, which `src/config/io.rs` honours on Windows
  before its platform fallback, plus `HERDR_SOCKET_PATH`. Children inherit those, so the aify
  wrappers clear them for the agents they launch — agents keep their real profiles.
- Ending the command ends the Job, which ends Herdr, the dedicated env and its workers. A later
  invocation mints a fresh UUID, and the daemon refuses a context whose receipts already exist, so
  **no previous invocation's agents can be resurrected** — enforced by the filesystem, not by a rule
  somebody has to remember.
