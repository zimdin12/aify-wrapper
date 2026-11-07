# Resident process identity

The owning format is `aify-env/docs/PROCESS-IDENTITY-v1.md` (env#22). This writer change does not
change registry rendering (wrapper#22) or either repository's #17 ownership/durability policy.

## Who is recorded

Named Claude/Codex/Hermes resident launches call `bin/aify-lifetime.sh`, which writes through
`bin/aify-resident-record.mjs` to `~/.aify/residents/<agentId>.<lifetime>.json`. Its PID is the **waiting
launcher shell**, not the runtime child or the formatter's Node process. The shell does not need to
exec the runtime: its own PID/start identity stays stable while the child runs. Existing anonymous
and host-managed early returns, startup `operatorStart`, epoch-microsecond clock, exclusive private
file creation and release behavior stay unchanged. No gateway, agent-lease or env-owned record changes.

## Optional Linux evidence

On Linux Bash, including WSL, the owning shell reads its complete `/proc/$$/stat` and boot ID using
built-ins. The whole stat includes any newline or parentheses in comm. Both raw captures travel in
the existing formatter invocation, after the explicitly reserved optional startup-capture slot.
No new process, PowerShell query, parent-PID inference or record-PID backfill is used.

When the capture validates, root `startToken` has exactly these five fields:

| Field | Value |
|---|---|
| `version` | integer1 |
| `platform` | `linux` |
| `bootId` | lowercase boot UUID |
| `pid` | the record's same positive safe-integer launcher PID |
| `startTicks` | raw decimal string from stat field22, never Number/epoch/btime conversion |

The pure env-owned `lib/linux-process-token.mjs` is copied byte-for-byte and loaded optionally only
when raw Linux captures exist. A missing, syntactically broken or failing parser in a partial bundle
omits the token while still writing the existing valid resident record; it never adds a launch failure.
The full-package equality and native-positive gates still require the real parser to ship and work.
It checks the leading captured PID before splitting after the final comm terminator. A deliberately child-PID record,
missing/unreadable capture, malformed boot ID or invalid stat produces **no startToken**, not a
fabricated token or a new launch failure. Raw stat/comm is not persisted or printed.

Windows Git Bash/Cygwin performs no Linux capture and writes no new field, even if proc-shaped files
exist. WSL's Linux shell publishes Linux evidence; that does not establish Windows-side PID identity
or widen existing Node/path interop support. Windows CreationDate policy is unchanged.

## Readers and compatibility

Current env requires observed liveness, the matching token and launcher command identity for Linux
adoption. A validly shaped but mismatching token remains parseable yet verifies unknown, never yes.
An old pre-token env reader accepts the additional JSON field but drops it; it gains no Linux identity.
Reader source must land before writer source; neither publication authorizes mixed-version live adoption.

The copy and env's shared process-identity fixture are held by tests, with an explicit fail-closed
`AIFY_ENV_SCHEMA_REPO` contract-source override when the host's sibling env checkout is frozen/stale.
Future env leaf changes ship with the wrapper copy and equality gate. Native Linux/WSL producer →
formatter → record → current env verifier must actually run in qualification; absence is NOT_RUN, not
passing proof. Synthetic multiline-stat carrier tests are labeled separately from real procfs proof.
