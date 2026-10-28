# Contract: the turn-start request aify-wrapper sends the dashboard

Agreed with aify-dashboard on 2026-10-28. The dashboard enforces its side in `server/src/routes/turn-start.ts`
(`requestFrom`); this side is `bin/aify-turn-start.mjs`, which builds the request, and `lib/turn-start.mjs`, which sends
it. A change to either side that breaks a clause below is a contract change: agree it first.

## When a request is sent

Once per turn, from the `UserPromptSubmit` hook (and `SessionStart`), to every service whose registry entry declares
`turnStart`, all at once, inside one deadline (`TURN_START_DEADLINE_MS`, 1500 ms) and each service's own `budgetMs`.

**Nothing is sent**, and the hook adds nothing, when:

- the launch names no agent (`AIFY_AGENT_ID` empty);
- the hook input carries no `session_id`;
- the turn is a Codex subagent's (`agent_id` in the input): its parent's turn already carried the rules;
- the service's key cannot be read (no `credentialRef` file, or one aify-env would refuse as bytes).

So `sessionKey` is never empty on the wire. The per-turn key read checks no file custody: custody is checked at launch,
and an icacls spawn on every prompt would eat the deadline (decided 2026-10-28).

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
| `moment` | string, optional | `start`, `compact` or `turn`; **left out** (never `null`) when the input names none. The dashboard reads a word it does not know as `start`, so a newer runner's moment costs a brief, never the agent's orientation |

aify-wrapper does **not** send `isFirstTurn`.

## The answer

A `200` with a string `text` adds that text to the turn. Anything else (another status, no `text`, a redirect, an answer
after the budget) adds nothing; the runner always exits 0. A late answer is dropped by the runner, not by the service.

## The tests that hold it

- `tests/the-turn-start-runner-asks-every-service-in-time.test.js`, "END TO END: the hook sends the runner-built
  request": the whole body and both headers, against a real local service.
- the same file: no request without an agent id or a session id; nothing for a Codex subagent's turn; the compaction's
  `moment`, and "NO MOMENT", which holds that an input naming none sends no `moment` field at all; the deadline and
  each budget; the per-turn read checking no custody.
- `tests/a-hermes-turn-carries-what-the-turn-start-services-say.test.js`: the same request from a hermes turn.
