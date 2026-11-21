# Turn-start request contract

`bin/aify-turn-start.mjs` builds the request; `lib/turn-start.mjs` sends it to each service that
opts in with [`turnStart`](../REGISTRY.md). The dashboard receiver agreed on 2026-10-28 reads it in
`server/src/routes/turn-start.ts` (`requestFrom`). A change to the request or reply contract needs
agreement with its receivers.

## When a request is sent

The runner asks opted-in services in parallel at `UserPromptSubmit` and `SessionStart`, inside its
existing deadline (`TURN_START_DEADLINE_MS`, 1500 ms) and each service's own `budgetMs`.

The runner sends no request when the launch names no agent (`AIFY_AGENT_ID` is blank), the hook input
has no `session_id`, or the input is for a Codex subagent (`agent_id` is a string). It skips a service
whose key cannot be read. The per-turn key read checks credential bytes but skips the custody check
performed at launch.

## The request

`POST <endpoint><turnStart.path>`, `content-type: application/json`, redirects refused.

| Header | Value |
| --- | --- |
| `x-api-key` | the key the service's `credentialRef` names |
| `x-aify-agent` | the agent id, as in the body |

| Body field | Type | Value |
| --- | --- | --- |
| `agentId` | string | the launch's agent (`AIFY_AGENT_ID`), never empty |
| `cwd` | string | the hook input's `cwd`, else the runner's own folder |
| `machineId` | string | `machineIdFor` (aify-env's rule, `lib/machine-id.mjs`) |
| `sessionKey` | string | the harness's own session id (`session_id`), never empty |
| `moment` | string, optional | `start`, `compact` or `turn`; left out, not `null`, when the input names none |
| `wsl` | object, optional | observed distro and drive mounts; see [WSL turn-start facts](../TURN-START-WSL.md) |

aify-wrapper does not send `isFirstTurn`. The dashboard treats an unrecognized `moment` as `start`;
that is dashboard behavior, not a requirement on other services.

## The answer

A `200` with a string `text` adds that text to the turn. A failed, invalid or late answer adds nothing;
neither does an answer containing a key presented by this runner. The runner exits 0.

## The tests that hold it

- `tests/the-turn-start-runner-asks-every-service-in-time.test.js`, "END TO END: the hook sends the runner-built
  request": the whole body and both headers, against a real local service.
- The same file covers absent agent or session id, Codex subagents, compaction and omitted `moment`,
  deadlines and the per-turn read without custody checks.
- `tests/a-hermes-turn-carries-what-the-turn-start-services-say.test.js`: the same request from a Hermes turn.
