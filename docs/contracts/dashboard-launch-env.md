# Contract: what a launcher exports that the dashboard's bridge reads

Agreed with aify-dashboard on 2026-10-28. The dashboard reads these in `server/src/bridge/launch-facts.ts` (since
aify-dashboard 69accd19) and `server/src/bridge/settings.ts`; its stdio bridge is started inside the session by the
registry's `sessionInject` entry, so it sees the environment the launcher exported to the runtime.

| Name | Exported by | The bridge |
| --- | --- | --- |
| `AIFY_AGENT_ID` | every launcher (claude, codex, hermes, pi) | required. Empty, or any value that is wholly `${...}` (an unexpanded placeholder such as `${AIFY_AGENT_ID}`), is no agent: the bridge registers nothing, and every tool says what is missing |
| `AIFY_RUNTIME` | every launcher | stored with the registration as given |
| `AIFY_AGENT_ROLE` | every launcher | stored as given. **Not `AIFY_ROLE`**: no launcher ever exported that name, and the bridge read it until 69accd19, so no agent had registered a role |
| `AIFY_SESSION_MODE` | every launcher | stored as given |
| `AIFY_SESSION_HANDLE` | codex, hermes, pi; not claude | optional, stored as given, read by nothing in the dashboard today. claude-aify is not changed for it |
| `AIFY_MACHINE_ID` | no launcher: the operator's override | replaces the host part of the machine id, by `machineIdFor`'s rule. A launcher never sets it, so the operator's value reaches the bridge unchanged |

Also read by the bridge, never set by a launcher: `AIFY_SERVICE_REGISTRY` (another registry), and
`AIFY_DASHBOARD_URL` with `AIFY_DASHBOARD_API_KEY` (both, or the registry's `aify-dashboard` entry and its
`credentialRef` file).

**The folder.** The bridge registers the folder it starts in. No launcher changes directory: the runtime, and so the
bridge, start in the folder the launcher was started in (aify-env's spawn, or the operator's shell).

## The test that holds it

`tests/launcher-reports-its-own-state.test.js`, "every launcher exports what the dashboard's bridge reads": every
template exports the four required names, none exports `AIFY_ROLE` or `AIFY_MACHINE_ID`, and none changes directory.
What each value is at run time is held by the launchers' own tests (for example
`tests/a-launcher-takes-defaults-from-its-definition.test.js` for the role).
