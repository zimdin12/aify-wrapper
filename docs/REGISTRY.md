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

`lib/registry.mjs`, pure — text in, values out, no filesystem and no environment.

```js
parseRegistry(text)              // -> {ok, registry?, errors[]}
endpointFor(registry, name)      // -> string | null
mcpEntriesFor(registry)          // -> [{name, command, args, env}]
fingerprint(registry)            // -> stable short digest
```
