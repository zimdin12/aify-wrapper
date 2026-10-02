# `~/.aify/services.json` — the service registry

One file, written by services, read by the things that launch and run agents. It is how a launcher
learns that a service exists at all.

## Who writes it, who reads it

**Written by each service's installer**, one entry per service, under its own name. Installing
aify-comms adds `aify-comms`. Installing a graph service adds that. Nothing else edits it, and no
service touches another's entry.

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
| `<service>.sessionInject` | no | `{ "mcp": true }` adds this service's `mcp` servers to every default-mode Claude session, beside the operator's own. See below. |

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
- `sessionInject` is an object, `mcp` is `true` or `false`, and any other key is refused.

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
0.159.3, 2026-10-01). **Pending wiring:** the codex launcher does not read these words yet. When it does, it
appends them to its app-server array with `while IFS= read -r -d '' w; do …+=("$w"); done`, so no registry value is
ever parsed as shell, through the placeholder `SESSION_MCP_CODEX_B64`. Empty when nothing opted in or there is no
file. Exit 78 for a registry that does not parse; a server name that is not a plain TOML key; a variable name a
shell cannot export; a forwarded name that any service in the registry keeps a key in; or a command or argument
UTF-8 cannot carry (a lone surrogate).

Unlike Claude's env block, which binds each `endpointEnv` name to the entry's endpoint, codex's `env_vars`
forwards whatever value the app-server inherited under that name. The launcher integration must test what an
unset or conflicting inherited value does.

The claude template's placeholder is `SESSION_MCP_B64`. `render.sh` refuses a template with any placeholder
left, so an installer that renders the claude template must supply it, empty or not.

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
mcpEntriesFor(registry)          // -> [{name, command, args, env}]
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
