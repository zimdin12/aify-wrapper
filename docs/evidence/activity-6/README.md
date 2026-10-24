# File activity producer verification

PASSES IN TESTS on native Windows with Node 22.20.0 and 26.7.0. Each runtime passed 146 selected tests without skips. The full maintained suite discovered 1,106 tests, passed 1,040 and skipped 66 existing platform-specific tests, with no failures, cancellations or TODOs.

Cold and warm admitted events make one `O_APPEND` write of the encoded line, with no SQLite, lock, control publication or fsync. A retained loss marker does not veto later events. After a marked torn tail, one delimiter byte joins the next event in that same write and counts against its byte allowance. Byte and session bounds are best effort. Cursor, ACK and recovery state belong to the env consumer. The storage format is defined in `docs/FILE-ACTIVITY-SPOOL-v1.md`.

## Reproduce

Run with Node 22.20.0 and 26.7.0 separately. The native PATH must select the same Node version for npm workers and emitted hook commands.

```text
node --version
npm test -- tests/activity-producer.test.js tests/file-activity.test.js tests/activity-launcher.test.js tests/herdr-tool-parity.test.js tests/file-activity-capability.test.js tests/every-export-is-tested.test.js tests/no-oversized-source-file.test.js tests/no-source-bakes-in-a-host-path.test.js tests/render.test.js tests/session-mcp.test.js tests/a-launcher-finds-its-own-helpers-in-the-wrapper.test.js tests/wrapper-check-cli.test.js tests/an-agent-runs-once-per-host.test.js tests/a-resumed-session-finds-its-agent-through-the-bridge.test.js
AIFY_ENV_REPO="C:/path/to/aify-env" AIFY_COMMS_REPO="C:/path/to/aify-comms" npm test
```

Install dependencies in the env checkout and the comms checkout's `mcp/stdio` package first. The maintained runner supplies private homes and temporary roots. Tests execute rendered hook commands with synthetic tool input and reopen the files written. This does not establish live Claude timing, network delivery or activation.

Native logs, compiling mutation controls, calibrated write-byte measurements and executed drivers remain in ignored clone storage for owner review, not in this public directory.
