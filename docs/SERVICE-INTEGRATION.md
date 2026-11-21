# Add an HTTP MCP service

Start with a host that already has aify-env and the aify-wrapper launchers. An additional service can
put its tools in default-mode Claude and Hermes sessions without installing a bridge on that host.

## Serve the spec and checks

Serve this JSON at `GET /.well-known/aify-service` without requiring a key or redirecting. Here the
sample service is named `example-tools` and listens on `http://127.0.0.1:8765`.

```json
{
  "specVersion": 1,
  "name": "example-tools",
  "version": "1.0.0",
  "fixed": {
    "mcpTransport": "http",
    "sessionInject": { "mcp": true },
    "advertise": false
  },
  "artifacts": [],
  "mcp": [],
  "secrets": [{ "field": "credentialRef", "required": true, "probe": "api" }],
  "verify": {
    "health": { "path": "/health" },
    "probes": { "api": { "path": "/auth-check", "header": "X-API-Key" } }
  }
}
```

`GET /health` returns `200` without a key. `GET /auth-check` returns `401` without the right key,
including when the header is absent, and `200` with it. Neither check redirects. Empty `artifacts`
and `mcp` mean there is nothing to approve or install on the host. The HTTP entry comes from
`mcpTransport` and `sessionInject`, not from an `mcp` command. Do not add `keyEnv` to this opt-in or
put a key, an endpoint or a credential reference in `fixed`. Connect supplies the endpoint and stores
its own credential reference. The [registry field table](REGISTRY.md#schema) names each reader
and its validation rules. Opt into state, activity, advertising or turn-start only when you serve it.

## Serve the tools

Serve [Streamable HTTP MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
at the path in the packaged [HTTP path and header fixture](contracts/http-mcp.json). The launcher appends
that path to the configured endpoint, keeping any path prefix. Use the fixture as the wire reference:
vendor its bytes from a known wrapper revision in your service tests. Your service does not need to
import JavaScript or depend on the wrapper at runtime.

`X-API-Key` is the credential. Validate it before admitting an MCP request. The other headers name the
caller, machine and launch folder; they are context, not proof of identity or authority. A caller may
be unnamed. For tools that require an agent, check that context separately. To smoke-test the service,
accept `initialize`, list one tool such as `echo` with `tools/list`, and have `tools/call` return the
text it was given. For a stdio adapter's launch variables see the [launcher environment contract](contracts/launch-env.md).
For optional turn context see the separate [turn-start request and reply contract](contracts/turn-start.md).

## Connect and check

Write the service key to a private file. On the host, connect using the service name and base URL:

```bash
aify-wrapper-connect example-tools http://127.0.0.1:8765 --key-file ./example-tools.key
```

Connect probes the service before publishing the registry entry. It refreshes launchers with current
render records. If it reports a launcher stale, re-run that launcher's installer. For Hermes, apply
any pending server configuration through the normal installer or quiet start path. Launch with
`claude-aify` or `hermes-aify` in default mode, confirm that the tool is listed, then call it. The
service should receive the MCP request over HTTP with the key and launch context. Do not put a raw key
in the service spec or in command arguments.

Codex still uses local stdio. The target is the same HTTP contract after real Codex qualification
([comms #47](https://github.com/zimdin12/aify-comms/issues/47)). There is no generic forwarder to
install today. A stdio-to-HTTP forwarder is a fallback only if supported Codex versions cannot take
this HTTP configuration. Do not use the HTTP-only example as a claim of Codex support.
