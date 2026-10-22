# The aify channel as a Claude Code plugin: what Claude does with it (2026-10-22)

Claude Code 2.1.308 (npm), in throwaway `node:22-bookworm` containers. The API key is fake and `ANTHROPIC_BASE_URL` is
`fake-api.mjs` inside the container, which logs the `<channel ...>` envelopes in each request body: that is the text the
model receives. `stub-channel.js` stands in for aify-comms' `claude-channel.js` and logs its parent, its configuration and
the variables it inherited. The policy is written by `lib/channel-policy.mjs`'s merge to the Linux managed-settings file.
Commands are at the top of `run.sh` and `run-2.sh`.

## Observed (`out/`, `out-2/`)

| case | configured | started with | servers started | delivered, as the model sees it |
|---|---|---|---|---|
| A | plugin only | `--channels plugin:aify-channel@aify-local` | the plugin's; its parent is `claude` itself | `<channel source="plugin:aify-channel:aify-comms-channel">` |
| B | plugin + user-scope server, **same command** | `--channels plugin:…` | only the user-scope one (Claude dropped the duplicate) | nothing: the agent would never wake |
| C | same as B | `--dangerously-load-development-channels server:aify-comms-channel` | only the user-scope one | `<channel source="aify-comms-channel">` |
| D | plugin (args + `--from-plugin`) + user-scope, gate on | `--channels plugin:…`, `AIFY_CHANNEL_ROUTE=plugin` | both; the user-scope one inert | `plugin:aify-channel:aify-comms-channel`, from the plugin |
| E | same as D | development flag, `AIFY_CHANNEL_ROUTE=dev` | both; the plugin's inert | `aify-comms-channel`, from the user-scope server |
| F | same as D | plain `claude`, no route variable | both; the plugin's inert | nothing (no channel flag), as today |

Also observed:
- The launcher's environment reaches the plugin's server: `AIFY_CHANNEL_ROUTE` and `AIFY_SERVER_URL` were inherited.
- No channel process outlived its session.
- `installed_plugins.json` is `{"version": 2, "plugins": {"aify-channel@aify-local": [{scope, installPath, version, …}]}}`.
- `settings.json` gets `enabledPlugins["aify-channel@aify-local"]: true`.
- The route answers (`route-*.txt`) are `dev` with no policy, `dev` with the policy but no plugin, and `plugin` once it
  is installed.

## What this settles

- **The source label changes on the plugin route.** The model sees `plugin:aify-channel:aify-comms-channel`. The terminal
  arrow still shows `aify-comms-channel`.
- **No shim is needed.** A plugin whose server runs `node <bridge>/claude-channel.js` directly has `claude` as its parent,
  the same as today's server.
- **Two configured servers both start once their commands differ.** Exactly one producer then has to be enforced by the
  servers themselves (the gate), not by the flag.

Not shown here: Windows, the per-user registry policy, a personal-account login, and the real `claude-channel.js`.
