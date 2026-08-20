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
| `78` | configuration invalid: a required input is missing or empty |
| `127` | the runtime CLI is not on PATH |

Anything else is the runtime's own exit code, passed through unchanged.

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

`--check` reports the wrapper's own version so a host can tell what it has. aify-comms compares it
against the checkout in `aify-comms doctor`'s `wrapper-current` check, which says REINSTALL where
`bridge-current` says RESTART.

## Where the runtime is loaded from

Point `--bridge-dir` at a **fast local path**. Where aify-comms keeps its bridge on a 9p/WSL2 mount the
bridge takes about five seconds to load, and hermes' MCP discovery window is a hardcoded 0.75s: the
result is a hermes that starts perfectly and silently has no tools. A native copy loads in about 0.3s.
This is not a performance nicety.

## Tests

```bash
node --test tests/*.test.js
```

They render each launcher and run it, rather than reading the templates. A wrapper's failure mode is
silence, so a test that only reads text cannot see it.

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

The remedy is **reinstall**, never restart. A launcher has exec'd and gone by the time anything is
running, so relaunching an agent changes nothing about it.
