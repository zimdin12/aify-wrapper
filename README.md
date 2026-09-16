# aify-wrapper

Launchers for coding-agent CLIs. A wrapper resolves the runtime, exports an identity environment,
points the runtime at an MCP bridge, and execs it with your arguments forwarded.

Four are here: `claude-aify`, `codex-aify`, `hermes-aify`, `pi-aify` (with `omp-aify` as an alias).

They were generated inside [aify-comms](https://github.com/zimdin12/aify-comms)' 4,371-line installer
until v0.6, each body living in an unquoted heredoc where every runtime `$` had to be written `\$` and
hermes carried 90 escaped backticks. This repo is that text made into files, so a host other than
aify-comms can install a launcher without taking the service with it.

For a while both repos carried the templates and a hash gate in each kept the copies honest. Since
2026-08-20 there is one copy: aify-comms deleted its own and now depends on this package, so a
template edit here reaches it through a version bump rather than through a second commit that has to
remember to match.

The third repo is [aify-env](https://github.com/zimdin12/aify-env), which owns processes and terminals
on a host. It runs launchers rendered from these templates, and decides whether it may run one by
reading the `HARNESS_WRAPPER_VERSION` marker out of the file — the same marker `--check` reports.

## Install

```bash
./install.sh --all --endpoint http://127.0.0.1:8800
```

`--all` installs a launcher for every harness runtime found on PATH, and nothing for the ones that are
absent. That is the point of this package: one command on a new host, however many harnesses it happens
to have. Use `--client <name>` instead when you want exactly one.

```bash
./install.sh --client claude --endpoint http://127.0.0.1:8800
```

Either writes into `~/.local/bin` (override with `--dest`). Run `./install.sh --help` for the rest.

### The registry

```bash
./install.sh --all --endpoint http://127.0.0.1:8800 --registry ~/.aify/services.json
```

`--registry` names the service registry a launcher is built against; it defaults to
`~/.aify/services.json`, which is where each installed service writes its own entry. The launcher bakes
in a FINGERPRINT of what it was built from, so `aify-wrapper-check` can tell you later that the registry
has moved on and the launcher has not. Install with no registry and you get a launcher built from
nothing, which is a valid state and reported as such rather than as an error.

Then, before you trust a launcher you just installed:

```bash
claude-aify --check
```

**Only on one you just installed.** A launcher predating the contract does not know `--check` and will
forward it to the runtime, which launches the harness instead of answering. That is why
`aify-wrapper-check` exists: it READS the launchers rather than running them, so it is safe to point at
whatever a host already has.

`--check` resolves the whole configuration, prints it, and **starts nothing**. That is not politeness.
The rule behind it was learned the expensive way: running a launcher to see whether it worked once
superseded a live environment bridge and reaped every managed worker under it. A launcher needs a way
to be asked without being run.

| Option | Meaning |
|---|---|
| `--client` | `claude`, `codex`, `hermes` or `pi` |
| `--endpoint` | the coordinating service, baked in as the fallback. Required: a wrapper will not guess one |
| `--dest` | where to install (default `~/.local/bin`) |
| `--bridge-dir` | directory holding the MCP bridge (default `~/.aify-comms/mcp/stdio`) |
| `--native-base` | the bridge's install root (default `~/.aify-comms`) |
| `--host-repo` | your checkout, for hooks that run from source |
| `--set KEY=VALUE` | an extra placeholder, repeatable |
| `--render-only DIR` | write the launcher into `DIR` and stop, touching nothing else |

### Updating

Re-run the installer. A launcher is generated text, so an update is a rewrite of that text -- there is
no in-place upgrade and nothing to migrate.

```bash
git pull && ./install.sh --all
```

`--endpoint` is required for a FIRST install and this refuses to guess one: an agent pointed at the
wrong service is a worse outcome than an install that stopped. On a reinstall it is optional, because
the endpoint is already baked into the launcher in `--dest` and gets read back out of the file. The
installer prints which one it reused; passing `--endpoint` overrides it.

Reading, not running. Asking a launcher for its endpoint by executing it would start a coding-agent
runtime, which is a large side effect for a question.

### Which transport the runtime uses for MCP

```bash
./install.sh --all --endpoint http://host:8800                     # stdio (default)
./install.sh --all --endpoint http://host:8800 --mcp-transport sse # the container serves MCP
./install.sh --all --endpoint http://host:8800 --service my-service # launchers for another service
```

`stdio` spawns the service's own bridge from this host. That is the only reason a host carries a copy
of the service at all -- on aify-comms it is 92 MB under `~/.aify-comms`. `sse` points the runtime at
`<endpoint>/mcp/sse`, so the client side needs no service code.

Default is stdio, and a launcher rendered today is byte-identical to one rendered before the flag
existed. Repointing a live fleet's transport is the operator's call, not an upgrade side effect.

The URL is built from the endpoint the launcher RESOLVES at run time, not the install-time literal.
Baking it is a real bug this pattern already fixed once: a strict-mode session announced one endpoint
while its bridge talked to another.

## Which service the launchers are for

`--service` names it, and defaults to `aify-comms`. It sets the MCP server key in the launcher, and the
channel server is DERIVED from it -- two names that must agree are a defect with a delay on it. The
name lands in a JSON key and a shell word, so anything outside `[A-Za-z0-9_-]` is refused rather than
rendered into a launcher that breaks when it is read.

The default render is byte-identical to what it always was, so an existing fleet does not move.

**What is NOT parameterised, deliberately: the paths.** `~/.aify-comms` in a rendered launcher is where
that service's runtime lives, and it already comes from `--bridge-dir`. Identity and location are
different axes, and only identity was missing.

This matters because the contract below was always generic -- every variable is `HARNESS_*`, never
`AIFY_COMMS_*` -- while the rendered bodies wired one service in executable lines. aify-env alongside
this package has no such coupling at all: zero dependencies, and every mention of aify-comms in it is a
comment.

## The contract

Six inputs, read at launch. Every one falls back to the legacy `AIFY_*` name, so an existing fleet
keeps working untouched.

| Input | Meaning | Required |
|---|---|---|
| `HARNESS_ENDPOINT` | base URL of the coordinating service | yes |
| `HARNESS_MCP_COMMAND` | command that starts the MCP bridge the runtime should load | no |
| `HARNESS_IDENTITY` | opaque id for this agent, exported to the runtime | no |
| `HARNESS_ROLE` | opaque role string | no |
| `HARNESS_CWD` | working directory the runtime starts in | no |
| `HARNESS_EXTRA_ENV` | `KEY=VALUE` lines exported verbatim before launch | no |

Precedence is **flag > `HARNESS_*` > legacy `AIFY_*` > the value baked in at install**. An explicit
argument beats ambient environment because that is what typing it means.

`HARNESS_ENDPOINT` uses `${HARNESS_ENDPOINT-...}`, not `${HARNESS_ENDPOINT:-...}`, and the difference
is deliberate: an explicitly **emptied** endpoint is a configuration error, not an unset one. A host
that cleared it gets exit 78 rather than an agent quietly talking to a service nobody named.

`HARNESS_MCP_COMMAND` is the input that makes these reusable. A wrapper otherwise knows where one
particular service keeps its bridge; with this it loads whatever the host names. Claude honours it.
Codex, hermes and pi accept it and **report it as unused** through `--check`, because their MCP servers
are registered at install time by the client's own tooling rather than by the launcher. A wrapper that
silently swallowed the input would be claiming a job it does not do.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | the runtime exited normally, or `--check` passed |
| `75` | start refused: the agent already has a live instance on this host (see below) |
| `78` | configuration invalid: a required input is missing or empty |
| `127` | the runtime CLI is not on PATH |

Any other code is the runtime's own, passed through unchanged. A runtime can also exit with one of the
codes above for its own reasons, so a `75` or `78` is the launcher's only when it printed why.

### One live instance per agent

Before the runtime starts, a launcher claims a lease for its agent id at `~/.aify/agents/<id>.json`
(directory overridable with `AIFY_AGENT_LEASE_DIR`). The code is `lib/agent-lease.mjs`, called through
`bin/aify-agent-lease.mjs` and `bin/aify-lease.sh`. A launch with no agent id, or a `--shared` launch
that hands the session to the host, does not claim; the host's own run of the launcher does.

**Start intent.** `start` or `replace`, decided in this order:

1. `AIFY_START_INTENT`, or the launcher argument `--aify-start-intent=start|replace`, which is consumed
   and never reaches the runtime. An invalid value means `start`.
2. A managed launch (`AIFY_SESSION_MODE=managed`) means `start`.
3. A person who **names the agent on the command line** (`--aify-agent` or `--agent-id`) means `replace`.
4. Anything else means `start`: an identity taken from the environment (`AIFY_AGENT_ID`,
   `HARNESS_IDENTITY`) or recovered from a conversation (`--resume <id>`) is a guess about who is meant,
   and a guess never ends a live instance. On 2026-09-15 one came from a pane that had inherited another
   agent's session, and replaced that agent.

**A shell inside a running agent session hands a start none of that session.** When `AIFY_AGENT_LEASE` or
`CLAUDE_CODE_CHILD_SESSION` is set, the launcher first unsets the conversation that session holds
(`CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, `HERMES_SESSION_ID` and the rest) and its start intent. It also
unsets the session's agent id, role, cwd, mode, terminal and model, keeping them only for a command that names
the agent this environment belongs to -- or names one where the environment names nobody, which is a host that
composed the launch (an aify-env started inside a Claude Code session passes a marker on to its workers). So a
bare launch starts anonymous, and one agent's shell starting a DIFFERENT agent hands it none of this session's
values, which would otherwise have that agent reporting itself in the first one's terminal.
The lists are in `lib/inherited-session.mjs`, and the launcher prints one line naming what it dropped. An
intent given as `--aify-start-intent=` is the command's own and is kept. `herdr-aify` starts its Herdr server
without any of these, so no pane inherits the session it was run from.

**When the agent is already running on this host:**

- `start` is refused with exit 75 and a message naming the live process.
- `replace` stops the live instance and every process it attached (the codex app-server, the hermes
  delivery loop and gateway), then starts.
- A launch inside the agent's own live instance (it inherited that instance's `AIFY_AGENT_LEASE`, or the
  instance is its ancestor) is refused with 75 whatever its intent.
- If a recorded process is still running but the host cannot read its process table, the start is
  refused with 75. Retry.
- If another start of the same agent has held the lock for over a minute, this one gets 75.

Leftovers of a dead instance are always stopped, whatever the intent. A pid is stopped only when it is
provably the recorded process (by its start time, or because it was seen alive before that process
started). The claimer's own ancestry is never stopped, and another agent's leased processes are never
crossed into.

**Nothing that hosts another agent is stopped.** A process whose tree holds another agent's leased process
(a Herdr server or an aify-env started from this agent's shell, with agents inside it) is left running. A
replace of a live instance that hosts one is refused with 75 and says so, because ending it would end that
agent too. A dead instance's leftover that hosts one now belongs to that agent and stays. On Linux, processes
are signalled one by one, never as a process group, so another agent that shares the group is not reached.
A daemon started from the session that hosts no agent is still stopped with it.

**Start times survive a clock step on Linux.** A process's start is computed from the boot time, which the
kernel derives from the wall clock at each read. The first reader after boot keeps that boot time in
`/dev/shm/aify-boot-<uid>-<boot id>`, and later readers use it, so a clock step does not turn a live instance
into what looks like a reused pid. Those start times are then on the anchor's clock rather than the wall
clock, and the two drift apart (121 s on this machine's WSL, a day after the anchor was written), so anything
compared against a wall-clock moment -- a lock holder's, hermes' own record of when it started -- subtracts
that offset first (`anchorOffsetMs`). Everything the lease writes down is on one clock.

The launcher exports `AIFY_AGENT_LEASE` (its own pid) to the runtime so detached helpers can attach to
the instance.

**An agent that ends leaves nothing running, however it ends.**

- **A clean exit** stops every process the instance attached, then releases the record.
- **A killed launcher** (a closed terminal, `taskkill`, a host tier stopped hard) runs no exit path.
  So every claim also starts a **watch**: one small detached process outside the launcher's tree. When
  the instance ends, the watch stops what it attached and every process it left running, then exits.
  It also exits as soon as the record names another instance, or none.
- **Anything that will not stop**, or a process table that cannot be read, keeps the record. The next
  claim stops what is left.

`AIFY_AGENT_LEASE_WATCH=0` starts no watch; the suites set it where they judge the claim alone.

**Failure is open, except for the refusal.** A helper failure (a bad argument, an unwritable directory)
prints a warning and lets the launch through without the guarantee; a missing helper, or no `node` on
PATH, lets it through without a word. A failed claim exits 70, and the launcher then does not export
`AIFY_AGENT_LEASE` or act as the holder: only a claim that succeeded holds the lease. The launcher loads
the helper from the bridge's installed copy of this package,
`@@BRIDGE_DIR@@/node_modules/aify-wrapper/bin/aify-lease.sh`, so after bumping a service's pin on
aify-wrapper, reinstall that service or its launchers run without a lease.

**It heals itself.** A dead or reused recorded pid is handled by the next claim, and an abandoned lock is
taken over when its holder is gone or after 2 minutes. Reset by hand only when a refusal names a process
that really is gone: delete `~/.aify/agents/<id>.json` and `<id>.json.lock`.

## Templates

`wrappers/*.sh.in` are ordinary bash with two additions: `@@TOKEN@@` placeholders a host substitutes at
install time, and `#|` lines that document the template and are stripped from the output.

| Placeholder | Supplied by |
|---|---|
| `@@ENDPOINT@@` | `--endpoint` |
| `@@WRAPPER_VERSION@@` | this repo's `VERSION`, so `--check` can report what it is |
| `@@BRIDGE_DIR@@` `@@NATIVE_BASE@@` `@@SCRIPT_DIR@@` | `--bridge-dir`, `--native-base`, `--host-repo` |
| `@@HERMES_PLUGIN_PATH@@` `@@HERMES_STDIO_DIR@@` `@@HERMES_TUI_DIR@@` | `--set`, defaulted from the above |

A placeholder the host does not supply is refused at render with exit 78. Left alone it would reach
the launcher as literal `@@TOKEN@@` text and break at the moment somebody tried to start an agent,
long after the install reported success.

Hermes needs three the others do not, because they cannot be derived from a checkout: a plugin path
converted for a native-Windows runtime, a bridge directory in a form Git-Bash `node` can open, and a
prebuilt TUI bundle that is baked only when it exists. An empty TUI dir means "locate or build it as
before", which never breaks.

## Version skew

A launcher is generated **text**. Restarting it changes nothing; only reinstalling does. That is the
opposite of the bridge it points at, which is a running process that keeps whatever it loaded at boot.

`--check` reports the wrapper's own version so a host can tell what it has. Whether the installed
launchers are current is answered by `aify-wrapper-check` (below), which reads them without running
them and says REINSTALL, where aify-comms' `bridge-current` says RESTART. That check used to live in
`aify-comms doctor` as `wrapper-current` and has left it.

## Where the runtime is loaded from

Point `--bridge-dir` at a **fast local path**. Where aify-comms keeps its bridge on a 9p/WSL2 mount the
bridge takes about five seconds to load, and hermes' MCP discovery window is a hardcoded 0.75s: the
result is a hermes that starts perfectly and silently has no tools. A native copy loads in about 0.3s.
This is not a performance nicety.

## Tests

```bash
npm test
```

`npm test` runs the suite through `tests/run-in-a-temp-root.mjs`, which gives it one temporary root and
deletes it afterwards.

They render each launcher and run it, rather than reading the templates. A wrapper's failure mode is
silence, so a test that only reads text cannot see it.

## Herdr

Two commands and a plugin, so agents launched through these wrappers survive a machine restart as
themselves. Full design, the measurements behind it and the limits are in [HERDR.md](HERDR.md).

**Ordinary Herdr keeps aify agents.** Start `claude-aify` in a Herdr pane, reboot, and it comes back
as `claude-aify` rather than as a bare `claude`. Panes running a bare agent keep Herdr's own native
resume and are not touched.

```bash
aify-herdr-pane install          # link the plugin — once per machine, nothing restores without it
aify-herdr-pane status           # what is recorded, and which pane each record is in
aify-herdr-pane restore          # run the restore now instead of waiting for a restart
herdr plugin unlink aify.wrappers
```

The wrappers do the rest by themselves: each labels its own pane and records the exact command it was
started with, gated on `HERDR_ENV` so an ordinary terminal launch pays nothing. It can never fail a
launch, and its diagnostics go to `~/.aify/herdr/claim.log` rather than to nowhere.

**`herdr-aify` is a separate Herdr with two modes**, and the argument picks the LIFETIME:

```bash
herdr-aify                       # this host's persistent Herdr: resident sessions, no aify-env
herdr-aify env                   # an isolated instance with a dedicated aify-env in its first space
herdr-aify --status              # what previous invocations left on this host
herdr-aify --stop                # end the recorded instance -- or the resident -- from any shell
```

`env` is the isolated one: its own socket and config roots, a dedicated `aify-env` in its first
space, and closing the command ends that Herdr, the env and its workers -- a later invocation cannot
adopt the previous one's processes. Plain `herdr-aify` is the opposite and is meant to be: ONE
persistent Herdr with wrapper support, where leaving the session DETACHES and the next launch comes
back to the same spaces and the same agents. `--stop` is how you end that one.

It does not touch an ordinary Herdr on the same machine, and it does not need the plugin. It also
does not need `herdr` on your PATH — Herdr only puts itself on the PATH of the shells it starts, so
the launcher resolves the binary itself and names every place it looked if it cannot.

**`--stop` is for how Windows ends a command.** Only a console Ctrl-C or a window close delivers a
signal, so a launcher ended any other way leaves its Herdr and its dedicated env running with an
owner pointer nobody will clear. `--stop` reads that pointer and reports whether the server really
went.

**If a command here prints nothing, the package needs re-linking.** npm creates bin shims at install
time, so a command added since the last `npm link` has none — and both of these were installed and
INERT for a day because of it. `npm link` in this checkout, or reinstall the package.

## Checking what is installed

```bash
aify-wrapper-check            # is every launcher here built from this host's registry?
aify-wrapper-check --json
aify-wrapper-check --strict   # exit 1 when anything is stale or unreadable
```

**It reads. It never runs a launcher.** A wrapper built before the harness contract does not know
`--check` and forwards it to the runtime, so a checker that asks instead of reads starts an agent.
There is a test that plants a launcher which would leave a sentinel file if it ever ran, and requires
the sentinel not to exist.

Three states, because two would lose the one that matters: **current**, **stale** (built from a
different registry, and it prints both digests so you can see they differ), and **unreadable** — a
launcher installed before fingerprints existed, which is the population most likely to be stale and the
one an absent-means-fine reading would report as healthy. A host with no launchers at all is not
"fine"; nothing was verified.

The remedy is **reinstall**, never restart. Relaunching an agent runs the same launcher text again, so
nothing about the launcher changes until the file does.
