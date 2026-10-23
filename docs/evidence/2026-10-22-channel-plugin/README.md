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

## Round 3: the real channel, with the producer gate (`run-3.sh`, `out-3/summary.txt`)

The run used aify-comms' real `claude-channel.js` and `claude-channel-plugin.mjs`, from the comms checkout, in Claude
Code 2.1.308. They ran against `fake-service.mjs`, where the user-scope server calls :9001 and the plugin's server calls
:9002, so every request names its process. The plugin was rendered by `lib/channel-plugin.mjs`.

| case | started | user-scope server | plugin's server | markers | envelope carrying the claimed message |
|---|---|---|---|---|---|
| plugin route | both | 0 requests | claimed it, delivered, beat | 1 (plugin) | `plugin:aify-channel:aify-comms-channel` |
| development route | both | claimed it, delivered | 0 requests | 1 (user-scope) | `aify-comms-channel` |
| control: gate deleted, plugin route | both | **8 claims, a beat, a marker** | claimed it, delivered | **2** | `plugin:aify-channel:aify-comms-channel` |
| control: gate inverted, plugin route | both | claimed it, delivered | 0 requests | 1 (user-scope) | **none: the wake is lost** |

With the gate deleted, whichever server claims first gets the message:
- In this run the plugin won, so the message arrived. In the first round-3 run the user-scope server won, and the wake
  was lost.
- So the observable that names this failure is the non-producer's own activity: its claims, its beat and its second
  marker. Delivery is not that observable.

No channel process outlived its session in any case. The route check (`route-*.txt`), against Claude's real files:
- says `plugin` for the real bridge;
- says `dev` for a downgraded bridge with no plugin entry ("is missing");
- says `dev` for a partial copy whose claude-channel.js lacks the declaration ("does not declare").

Liveness beats are timing-dependent here: the first beat fires before the agent binding exists, the next one 30 s later.
So the producer is identified by its accepted claim, its delivered receipt, its marker and the envelope, not by a beat
count.

Not shown here: Windows, the per-user registry policy, and a personal-account login.
