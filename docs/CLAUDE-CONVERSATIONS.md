# Claude conversation choice

An explicitly named operator launch, `claude-aify --aify-agent <id>` (or `--agent-id`), may resume that
agent's persisted Claude pin. This is a conversation default, not permission to replace a running
agent. Existing lease admission remains independent; an admission refusal still stops the launch.

## Precedence

- An explicit native conversation selector vetoes the default, including resume/-r, session-id,
  continue/-c and fork forms. Existing validation/forwarding behavior remains in force. An invalid
  explicit handle's fresh fallback is not replaced by a different service pin.
- A nonempty conversation choice surviving inherited-session hygiene also vetoes the default.
- `--new-session` explicitly requests fresh: it clears ambient conversation fields, skips pin lookup
  and is consumed before native execution. Combined with a native selector it refuses with 78 before
  lookup or runtime start.
- A matched incoming managed frame stays fresh without a new caller flag: requested id equals the
  incoming `AIFY_AGENT_ID`, incoming `AIFY_SESSION_MODE=managed`, and `AIFY_MANAGED_VIA_WRAPPER=1`.
  The decision is after inherited-session hygiene and before this launcher exports its identity/mode.
  It does not depend on an empty handle remaining present, and never restores scrubbed handles.
- `--check`, preliminary `--shared`, and anonymous/env-only/recovered identity do not request a pin.
  Shared forwards original arguments without `--shared`; its actual child makes the decision.
  Herdr's claim receives original arguments, including the fresh escape, before native filtering.
- Otherwise the explicitly named launch asks once. A valid pin must have a regular local transcript
  in the selected profile. Missing, foreign-runtime, malformed or unavailable pins visibly fall back
  to useful fresh launch. There is no latest-transcript guess, retry queue or replacement authority.

An implicit resume adds `--resume <UUID>`, exports that same `CLAUDE_SESSION_ID`/`AIFY_SESSION_HANDLE`,
and uses today's configured model unless an explicit model was supplied. Managed reaping additionally
requires this invocation's actual matching won lease; an inherited lease PID is not a won claim.

## Profile and model reporting

Transcript validation, resumed-default settings and the model reporter/catalog share the selected
profile calculation: `CLAUDE_CONFIG_DIR`, otherwise the native Node process's home plus `.claude`.
Native entry points supply `os.homedir()`; on Windows that is not an unrelated Git Bash `HOME`.
Only immediate project directories and regular transcript leaves are accepted; another profile's
matching UUID is not evidence for the selected profile.

The model reporter's fresh-zero/launch-EOF fences and receiver envelope are unchanged; see
[MODEL-SELECTION.md](MODEL-SELECTION.md). Selecting a pin does not itself report a model command.

## Comms-owned bridge contract

The wrapper consumes this optional program beside the bridge's existing handle lookup:

```text
node <bridge>/session-for-agent.mjs <resolved-endpoint> claude-code <agent-id>
```

Its controlled stdout is exactly one line: `found<TAB>UUID`, `none`, `wrong-runtime`, or `unavailable`.
One LF or CRLF ending is allowed. Nonzero exit, transport error, extra output, invalid UUID or missing
module is unavailable. Wrapper execution has a 3000 ms timeout and 4096-byte output limit; child
stderr/raw server bodies are not forwarded.

Comms owns credentials and the HTTP read: destination-scoped key/settings resolution, a two-second
GET deadline, manual redirects, and the existing `GET /api/v1/agents/:id` response. The persisted
`agent.sessionHandle` is the pin, never `pendingSessionId`. The root `agentId` identifies the requested
agent; the payload does not supply an `id` field.

**This change implements the wrapper half, not that service helper.** Until comms supplies it, an
eligible launch emits the unavailable/fresh line and starts fresh. Contract-stub tests do not qualify
comms credentials, HTTP behavior, installed delivery or native Claude execution.

## Regression scope

`a-named-claude-resumes-its-service-pin.test.js` reaches a sealed native stub through the rendered
launcher, including selector/profile/shared/Herdr boundaries and won/failed claim controls.
`managed-claude-conversation-intent.test.js` drives maintained comms private FastAPI/SQLite lifecycle
preparation through its actual argv/env producer and rendered launcher: reset, handoff, new definition
and resume, with and without a stale inherited marker. The service pin helper remains a contract stub.

The actual-producer test requires `AIFY_COMMS_REPO`. Optional `AIFY_COMMS_TEST_PYTHON` selects its
interpreter; `AIFY_COMMS_TEST_PYTHON_USER_BASE` supplies only a read-only package location to the child.
Both default to unset. Its home/data/temp/AppData remain fixture-owned; missing prerequisites fail
loudly as NOT_RUN, without a handcrafted managed-intent substitute. The receipt records interpreter,
FastAPI version, and before/after hashes of the named producer/fixture inputs.
