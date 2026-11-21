# Launcher environment contract

A service's stdio bridge started inside a runtime session sees the launcher's exported environment.
The launcher does not change directories. The runtime and bridge start in the working directory
set by the host or operator's shell.

## Launcher facts

| Name | Exported by | Meaning |
| --- | --- | --- |
| `AIFY_AGENT_ID` | Claude, Codex, Hermes, Pi | Agent id when the launch has one. A launch may be anonymous. |
| `AIFY_RUNTIME` | All four | The runtime name. |
| `AIFY_AGENT_ROLE` | All four | The resolved role. The launcher does not export `AIFY_ROLE`. |
| `AIFY_SESSION_MODE` | All four | The resolved session mode. |
| `AIFY_SESSION_HANDLE` | Codex, Hermes, Pi; not Claude | Optional runtime session handle. |
| `AIFY_MACHINE_ID` | None | Operator override for the host part of the machine id, by `machineIdFor`'s rule. The launcher does not replace it. |

See [the launcher contract](harness-wrapper.md#host-inputs-and-precedence) for how the launcher resolves its inputs.

## Dashboard stdio receiver

This is the receiver that the original 2026-10-28 agreement covered. It reads the launch facts in
`server/src/bridge/launch-facts.ts` and `server/src/bridge/settings.ts`. It registers its working directory
and requires an agent id. With an empty id or a wholly unexpanded placeholder such as `${AIFY_AGENT_ID}`,
it does not register and its tools explain what is missing. It records runtime, role and mode, and may
record the optional session handle. The role is `AIFY_AGENT_ROLE`, not the `AIFY_ROLE` the bridge read before 69accd19.

For its connection the bridge reads `AIFY_DASHBOARD_URL` and `AIFY_DASHBOARD_API_KEY`. If either is
missing it consults its registry entry and `credentialRef`. `AIFY_SERVICE_REGISTRY` can select another
registry. These are receiver settings, not launch facts.

## The test that holds it

`tests/launcher-reports-its-own-state.test.js`, "every launcher exports what the dashboard's bridge reads": every
template exports the four common names, none exports `AIFY_ROLE` or `AIFY_MACHINE_ID`, and none changes directory.
The launchers' behavior tests hold the values, for example `tests/a-launcher-takes-defaults-from-its-definition.test.js`
for the role.
