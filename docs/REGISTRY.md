# `~/.aify/services.json` — the service registry

One file, written by services, read by the things that launch and run agents. It is how a launcher
learns that a service exists at all.

## Who writes it, who reads it

**Written by each service's installer**, one entry per service, under its own name. Installing
aify-comms adds `aify-comms`. Installing a graph service adds that. Nothing else edits it, and no
service touches another's entry.

**Or by `aify-wrapper-connect`**, from the spec a service serves (README, "Connecting a service"). It writes
the raw entry, keeping every field the spec does not name, under `<registry>.lock`, and only when the file still
holds what it read. The lock binds cooperating writers only: aify-dashboard's own register (a temp file and a
rename, no lock) is not excluded by it; the reread catches it when it lands between connect's read and its
write.

**Read by aify-wrapper at install time** to decide what to bake into each launcher, and by the host
process runner when it starts.

**Read at install, never at launch.** A launcher that parsed JSON on every start would pay that cost
on every start, and hermes gives MCP discovery a 0.75 second window — a budget this project has
already blown once, which is why the bridge runtime is copied to a native directory instead of being
loaded from a checkout. So a launcher bakes what the registry said and carries a fingerprint of it.
Registering a service after a launcher was installed means re-running the install; `--check` reports
the launcher stale rather than leaving you to notice.

## Schema

```json
{
  "version": 1,
  "services": {
    "aify-comms": {
      "endpoint": "http://localhost:8800",
      "endpointEnv": ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"],
      "mcp": [
        { "name": "aify-comms",         "command": "node", "args": ["/home/you/.aify-comms/mcp/stdio/server.js"] },
        { "name": "aify-comms-channel", "command": "node", "args": ["/home/you/.aify-comms/mcp/stdio/claude-channel.js"] }
      ]
    }
  }
}
```

| field | required | meaning |
|---|---|---|
| `version` | yes | Exactly `1`. An unknown version is refused, never best-guessed. |
| `services` | yes | Object keyed by service name. |
| `<service>.endpoint` | yes | Where the service is reachable. |
| `<service>.endpointEnv` | no | The environment variable names **this service's own code reads** to find its endpoint. |
| `<service>.mcp` | no | MCP servers this service contributes to a runtime. Each needs `name` and `command`; `args` optional. |
| `<service>.mcpTransport` | no | `"stdio"` or `"http"`: how this service's launchers reach its MCP tools. Declared, it decides them over `install.sh --mcp-transport`, at install and at re-render, so the guided chain (which passes no flag) renders what the service serves. Absent keeps the flag, default stdio. Anything else is refused. |
| `<service>.sessionInject` | no | `{ "mcp": true }` adds this service's `mcp` servers to every default-mode Claude session and every codex session, beside the operator's own; with `mcpTransport: "http"`, Claude and Hermes reach it at its `/mcp/http` instead. See below. |
| `<service>.turnStart` | no | `{ "path": "/events/turn-start", "budgetMs": 800 }`: the route the turn-start runner (`bin/aify-turn-start.mjs`) calls as each Claude turn begins. `path` follows `agentState.path`'s rule; `budgetMs` is a whole number from 1 to `TURN_START_DEADLINE_MS` (1500), the runner's shared deadline, and defaults to it. Any other key is refused. See below. |
| `<service>.advertise` | no | Read by aify-env, not by this package. `false` means aify-env sends this service no environment heartbeat; absent, or any other value, means it does. This parser accepts the field and leaves it out of what it returns. A service plugin aify-env runs for the entry still heartbeats on its own, carrying the host's machine id (aify-env 0.8). |

## Why `endpointEnv` exists, and why nothing is guessed

A runtime's per-server MCP env block is **key-scoped**. Proven on Claude Code 2.1.236: a per-server
`AIFY_SERVER_URL` beat an inherited value for that key, while an inherited `AIFY_COMMS_URL` passed
through to the child untouched. The block sets the names it names and leaves the rest of the
environment alone.

So a service reading a name that its block does not set will inherit that name from whatever launched
the runtime — quietly, and correctly-looking, right up until two services disagree about where they
are pointed.

A service therefore declares which names carry its endpoint. **A service that declares none gets an
empty environment**, which is the honest answer. Filling in a plausible default would work silently
for whichever service the default was copied from and fail silently for every other one, putting the
symptom as far as possible from the cause.

## `sessionInject`: a service in every session

`"sessionInject": { "mcp": true }` puts the service's `mcp` servers into every Claude session the launcher
starts in the default mode. The launcher writes them to a per-session file and passes it as
`--mcp-config=<file>`, **without** `--strict-mcp-config`, so they load beside the servers the operator
configured (proven on Claude Code 2.1.286, 2026-10-01, with every user-level server still loaded). The
equals form is deliberate: the flag takes several values, and the spaced form reads any bare word after
it as a second config path. The launcher always appends `--settings` after it today, so nothing is
swallowed; the equals form keeps that true without depending on the order. The file is removed when the
session ends.
Nothing is written to `~/.claude.json`: running sessions rewrite that file, so an installer that edits
it races them.

- A host where no service opted in gets no `--mcp-config` at all, the same launch as before.
- Strict mode is unaffected. It carries `strictMcp` services only.
- The entry's env block holds the `endpointEnv` names bound to the endpoint, and nothing else.
- **`keyEnv` beside `sessionInject.mcp` is refused at parse**, because the key's value would be baked
  into every launcher (WRAP-M1). A service that opts in reads its key itself, from its `credentialRef`
  file.
- **An opted-in `endpointEnv` name that any service keeps a key in is refused at parse.** The rule above is per
  service, so without this an opted-in entry could name the variable a neighbour's credential lives in. Claude binds
  the name to this entry's endpoint, so the key never reaches the file, but the bridge's copy of the variable is
  silently a URL, and codex would forward the inherited value. Found by aify-comms' senior review, 2026-10-01.
- `sessionInject` is an object, `mcp` is `true` or `false`, and any other key is refused.
- Keys at entry level that this parser does not read, such as aify-env's `advertise`, are accepted and dropped from
  the parsed entry. Other readers of the same file own them.

The installer gets the document from `registry-cli.mjs session-fragment-b64 <path>`:

| case | stdout | exit |
|---|---|---|
| no service opted in, or no file | empty | 0 |
| one or more opted in | the `--mcp-config` document, base64, no trailing newline | 0 |
| a registry that does not parse | empty (reasons on stderr) | 78 |

**Codex** gets the same servers as `-c` words for `codex app-server`, which owns the session (the TUI only
attaches to it). `registry-cli.mjs session-codex-b64 <path>` (in `lib/session-codex.mjs`) prints, per
opted-in server, `-c mcp_servers.<name>.command=…`, `-c mcp_servers.<name>.args=[…]` and
`-c mcp_servers.<name>.env_vars=["AIFY_AGENT_ID", <endpointEnv names>]`, each word NUL-terminated, the whole
in base64. `env_vars` is required: codex passes an MCP server no variable it is not told to (measured on codex
0.159.3, 2026-10-01). `install.sh` bakes them into codex-aify through the placeholder `SESSION_MCP_CODEX_B64`. The
launcher decodes them to a file, refusing with 78 if they do not decode, and appends them to its app-server array
with `while IFS= read -r -d '' w; do …+=("$w"); done`, so no registry value is ever parsed as shell. Empty when
nothing opted in or there is no file. Exit 78 for a registry that does not parse; a server name that is not a plain
TOML key; a variable name a shell cannot export; a forwarded name that any service in the registry keeps a key in;
or a command or argument UTF-8 cannot carry (a lone surrogate). Those refusals are codex's own, so the installer
asks for these words only when a codex launcher is among the clients it writes. The refusals every client shares
come from the parse.

Unlike Claude's env block, which binds each `endpointEnv` name to the entry's endpoint, codex's `env_vars`
forwards whatever value the app-server inherited under that name. The launcher integration must test what an
unset or conflicting inherited value does.

**Hermes: for hermes, `sessionInject` means EVERY hermes session on the host,** not only hermes-aify ones. Hermes has
no per-session MCP flag, so `install.sh` writes each opted-in server into the user's hermes config, which every hermes
session reads, the way aify-comms' own entry is written. It does so only when a hermes launcher is among the clients,
and never with `--render-only`. Its managed-scope overlay (`HERMES_MANAGED_DIR`) looked like a per-session way in, but
measured on hermes 0.21.5 it deletes a same-named server from the user's config on any save, and leaves a dead
`<name>: {}` behind for any other name (aify-dashboard `docs/evidence/hermes-session-mcp-2026-10-02`).

- **Only what changed.** Every `config set` makes hermes rewrite the whole file, so an entry is set only when it is not
  current. After writing one the step reads it back with `hermes config get` and keeps a receipt in
  `~/.aify/hermes-config-receipts.json`, per hermes config: the digest of the value written and of hermes' answer. An
  entry is current only when the value it would be given now and hermes' answer now are both the receipt's; one edited
  under our mark, one with no receipt, or one in a config the receipt is not for is written. An install that would
  change nothing writes nothing, records nothing, and retires a change recorded for the same registry and config, all
  in one hold of the lock. A recorded change that has come to change nothing is retired by the next start, hermes
  running or not. The plan and the write under that lock share one deadline, ending before the lock can be taken from
  its holder, and no hermes call starts after it.
- **Never into a running hermes.** A running hermes reloads its servers when their content changes, so the install
  step (`lib/hermes-config-cli.mjs <registry>`, which aify-wrapper's `install.sh` and aify-comms' installer both run)
  records the change in `~/.aify/hermes-config-pending.json` (the registry's path and the hermes config it is for,
  never an entry) and applies it at once only if no hermes runs. Otherwise the first hermes-aify start of that same
  config that finds none applies it, under a lock, before it starts its own hermes; the starts behind it wait and
  launch with the change in place, and a start of another hermes home leaves it and says so. Recording takes the same
  lock, so a newer install is never lost to an apply retiring the older one. A process the scan cannot read counts
  as possibly hermes (see Known issues in the README). Until then `aify-wrapper-check` reports it pending
  (`lib/hermes-pending-config.mjs`).
- **Hermes' own writer.** `lib/hermes-config-cli.mjs --write-now`, the pending change's step, runs `hermes config get`, then `hermes config set
  mcp_servers.<name> '<JSON>'`, and `hermes config unset` for removal. The operator's comments and other servers
  survive, and nothing here edits YAML.
- **Only its own entries.** Each entry carries `"x-aify-owner": "aify-wrapper"`. A same-named entry without it is the
  operator's, and the install refuses with 78 rather than replacing it. An entry of ours that no service opts into any
  more is removed; nothing else is.
- **A `get` answer is trusted only with exit 0 and an empty stderr.** On an unparseable config hermes exits 0 and
  answers from its last good read, saying so only on stderr. Any other answer refuses with the step named.
- **Not while hermes is mid-update.** Before any hermes call, `installs/*/source-completion-pending` is looked for
  under every hermes root. Any hermes command run then would re-run that update. This reads hermes 0.21.5's private
  layout: finding a marker refuses, and finding none proves only that there is none where 0.21.5 keeps it.
- **What `lib/session-hermes.mjs` refuses:** everything the codex verb refuses, plus `${` in a server's command or
  arguments, because hermes expands `${...}` in arguments too. `AIFY_AGENT_ID` and every `endpointEnv` name go in the
  entry's `env` as `${NAME}`. Hermes gives a stdio server only its safe-env allowlist plus that block.
- **A session no launcher gave an id passes the server the literal text `${AIFY_AGENT_ID}`.** A service that opts in
  must treat it as no agent.

The claude template's placeholder is `SESSION_MCP_B64`. `render.sh` refuses a template with any placeholder
left, so an installer that renders the claude template must supply it, empty or not.

### Over HTTP: `sessionInject` with `mcpTransport: "http"`

A service that opts in **and** declares `"mcpTransport": "http"` is reached at `<endpoint>/mcp/http` as the launch's
agent, instead of through the local process its `mcp` entries start (`lib/session-http.mjs`, agreed with aify-comms
and aify-dashboard on 2026-10-28). Its stdio entries are then left out for Claude and Hermes, under the same name.
Codex keeps them: whether it sends headers, or expands variables in them, is not observed. A Claude launcher's **own**
service is reached the same way whenever the launcher is installed for http (`--mcp-transport http`, or the service's
declared `mcpTransport`), with or without `sessionInject`: that is aify-comms' per-launch entry, which this replaced.

- **One header set for every service:** `X-Aify-Agent-Id` (the launch's agent), `X-Aify-Machine-Id` (`machineIdFor`),
  `X-Aify-Launch-Folder` (the cwd Claude starts in, which a local process would have reported) and `X-API-Key`. A
  service ignores what it does not use.
- **The key, per service** (`sessionKey`): a key exported under a name the service itself declares in `keyEnv` wins;
  a service that declares none never takes an exported key, so one service's key cannot reach another's header.
  Otherwise the key its `credentialRef` names, only when the launch sends to the endpoint the registry names it for
  (an exported endpoint that moves the own service gets no credential), and only from a file aify-env's custody rules
  accept: not reached through a link, readable by its owner alone. This is aify-comms' `destinationKeyResolver` applied
  per service; `tests/the-session-key-is-resolved-as-comms-resolves-it.test.js` holds them equal.
- **No key, no header.** The entry is still written, without `X-API-Key`, and the service is named on stderr: the
  service decides, and a 401 reads as a credential problem where absent tools read as a broken install.
- **Claude, per launch.** `install.sh` bakes the list into the placeholder `SESSION_HTTP_B64`
  (`registry-cli.mjs session-http-b64 <path> [own service]`): names, endpoints, `credentialRef` and `keyEnv`, never a
  key, so the registry fingerprint still says what the launcher was built from. claude-aify runs
  `bin/aify-session-mcp.mjs` once per launch in the launch folder; it writes this list's entries and the stdio
  `sessionInject` servers into one `--mcp-config=<file>`. Because that file can hold keys, it is the agent's one
  `~/.aify/sessions/<agent id>/mcp.json` (`lib/session-folder.mjs`), in a folder made owner-only and checked before
  every write, never the session's temp: a launcher stopped with TerminateProcess skips its EXIT trap, so per-launch
  temp files piled up there. A launch nobody named uses `_pid-<launcher pid>/`, swept once its launcher has ended.
  Strict mode takes only the own service. Exit 78, and no launch, when that file cannot be written: a widened
  folder, unreadable rendered input, or two servers under one name.
- **Hermes, machine-wide.** `hermes-config-cli.mjs` writes `{url, headers}` for the other services with
  `X-Aify-Agent-Id: "${AIFY_AGENT_ID}"`, `X-Aify-Launch-Folder: "${workspaceFolder}"` (which Hermes resolves itself to
  the session's workspace root, else its cwd), and the machine id and key written as they are. **An unset `${VAR}` in a
  remote url or header makes Hermes refuse the whole server**, so a Hermes not started by hermes-aify (which sets
  `AIFY_AGENT_ID`) has none of these services' tools; aify-comms' own Hermes entry makes the same trade. **A running
  Hermes reloads `mcp_servers` when their expanded content changes**: a release that changes this entry installs with
  Hermes agents stopped, and the step says so whenever it writes.
- The key is in the entry because an HTTP server cannot read a credential file the way a local process does.

## `turnStart`: what a service says as a turn begins

The launcher registers one synchronous `UserPromptSubmit` command, `bin/aify-turn-start.mjs`, which a channel wake runs
as well as a typed prompt. It reads this file at run time, asks every service declaring `turnStart` at once, and adds
their answers' `text`, joined in the parser's service order, as the turn's `additionalContext`. Each request carries
`{agentId, cwd, machineId, sessionKey}` (`sessionKey` is Claude's `session_id`), the key the entry's `credentialRef`
names as `x-api-key`, and the agent as `x-aify-agent`. A service that is slow past its budget, fails, answers anything
but a 200 with a string `text`, redirects, or has no key contributes nothing; the runner always exits 0, and adds
nothing once `TURN_START_DEADLINE_MS` has passed. `machineId` is aify-env's derivation exactly (`lib/machine-id.mjs`).

## Rules the parser enforces

- **Absent is empty, not broken.** A missing, empty or whitespace file is a valid registry with no
  services. A host with nothing installed is a legitimate state, and it must stay distinguishable
  from a corrupt file — the two have opposite remedies.
- **Guards fail closed.** A registry that does not validate yields *no* registry, never a partial one.
  A partial registry is how a host ends up with launchers built against one service because the second
  failed validation quietly.
- **Duplicate MCP server names are refused.** `mcpServers` is a map, so a duplicate name does not
  error downstream — it silently drops one service, and which one survives depends on emission order.
- **Ordering is deterministic** (service name, then declaration order), so two installs from one
  registry render byte-identically. Without that, every reinstall looks like a change to anything
  comparing launchers.

## API

`lib/registry.mjs` touches no filesystem. It is NOT free of the environment, and the correction is
worth stating because this paragraph claimed otherwise twice: `mcpEntriesFor` binds each service's
`keyEnv` names by reading `process.env` directly, so the same registry yields different entries in
different environments — and every strict-fragment consumer inherits that, since they are built from
those entries. `strictMcpSecretProblem` is the one that takes the environment as a parameter,
defaulting to `process.env`.

Verified by review with an identical synthetic registry and a changed synthetic environment producing
changed output.

```js
REGISTRY_VERSION                 // the schema version this module speaks
parseRegistry(text)              // -> {ok, registry?, errors[]}
READ_FIELDS                      // every entry field parseRegistry reads; a spec's `fixed` may set only an owned one
TURN_START_DEADLINE_MS           // the turn-start runner's shared deadline, and the largest turnStart.budgetMs
mcpEntriesFor(registry)          // -> [{name, command, args, env}]
MCP_TRANSPORTS                   // the transports a service may declare: stdio, http
mcpTransportFor(registry, service) // -> the transport `service` declares, or ""
reachedOverHttp(service)         // -> whether an opted-in service is reached at its /mcp/http instead
fingerprint(registry)            // -> stable short digest
strictMcpEntriesFor(registry)    // -> the same entries, strict-MCP shaped
strictMcpSecretProblem(registry, env = process.env)  // -> a reason, or "" when there is none
strictMcpFragment(registry)      // -> the config fragment a strict-MCP client wants
strictMcpFragmentBase64(registry)// -> that fragment, base64, for an argv
sessionMcpEntriesFor(registry)   // -> the entries opted into every session, endpointEnv bound
sessionMcpConfig(registry)       // -> a whole --mcp-config document, or "" when none opted in
sessionMcpConfigBase64(registry) // -> that document, base64, for an argv
```

**This block is checked against the module's real exports** by
`tests/the-registry-doc-names-the-functions-that-exist.test.js`. It had drifted BOTH ways before that
test existed: it documented `endpointFor`, which this module EXPORTED once and no longer does — added
in `c07734f` and deleted in `4bec3c6`, both ancestors of main — and it
omitted five functions that do exist. A reader following it would have called something that is not
there and never learned about the strict-MCP half.
