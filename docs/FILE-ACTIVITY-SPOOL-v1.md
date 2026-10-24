# Claude file activity, ingress v1 and storage v2

The wrapper produces best-effort bounded local metadata, not a transactional queue.
The env shipper owns cursors, ACKs, gap identities, expiry, conflict recovery and
retention, in its own bounded state file written per shipped batch. The dashboard's
`FILE-ACTIVITY-CONTRACT-v1.md` owns HTTP validation. This document enables nothing.

## Hook and root

`AIFY_FILE_ACTIVITY=1` independently opts in. Absence or `0` is off; other values
are invalid. Each `PostToolUse` or `PostToolUseFailure` has one combined command,
`node "<wrapper>/bin/aify-tool-event.mjs" success` or `failure`. It reports existing
working state independently, then parses stdin and appends locally. There is no
network client, transcript reader or second JSON-parser child. Activity-off hooks
and non-tool state callers retain their legacy shell. Both SessionStart commands
and session-ID capture remain installed. Hook Node is resolved from its own PATH.

Only top-level Claude Read/Write/Edit `tool_input.file_path` records are supported.
Bash, contents, diffs, command strings, responses, errors and child/subagent fields
are refused. Paths normalize lexically without realpath or file-content reads.
Identity comes from `AIFY_AGENT_ID`, `AIFY_ENV_INSTANCE`, `AIFY_LIFETIME` or null,
the existing `machineIdFor` owner and the supplied session ID. Missing identity
never borrows a parent. `validActivityRecord` and the ingress record stay version 1.

Use the existing `leaseDirectory({env})` owner, including `AIFY_AGENT_LEASE_DIR`
and its existing host-home fallback. The result must be absolute. The exact root is
`<leaseDirectory>/<validated agentId>/activity-v2/`. Session input is never a path.
Leave all draft `activity-v1` roots unchanged. There is no migration or deletion.
The consumer receives the same explicit absolute lease directory, not a watch root,
project directory or new home-discovery scan. Local admission refuses root/ancestor
symlinks and junctions and non-regular target files. New-session admission validates
entries; warm append does not walk sibling sessions. This assumes cooperating local
writers, not hostile same-user replacement during admission.

## Exact storage layout

For source `s`, compute lowercase hex SHA-256 over the UTF-8 bytes of
`JSON.stringify([s.machineId,s.instanceId,s.agentId,s.incarnation,s.runtime,s.sessionId])`.
The segment is `session-<64 hex>.jsonl`. Property insertion order in `s` is irrelevant.
One complete UTF-8 line, ending in one LF, has exactly this envelope:

```text
{"storageVersion":2,"appendedAt":{"wallMs":<integer>,"uptimeMs":<integer>},
 "policy":{"sessionBytes":<integer>,"maxSessions":<integer>,"maxAgeMs":<integer>},
 "record":<unchanged validActivityRecord v1>}
```

The display wraps the line only for readability. `wallMs` is `Date.now()` and
`uptimeMs` is `Math.floor(os.uptime()*1000)`, sampled before append. Both are
nonnegative safe integers. The immutable record contains its original event ID,
source, adapter and event. Send `record.source` and `record.event`, never this
storage envelope. Omit WSL facts rather than inventing mutable facts on retry.

Defaults and inclusive maxima are 8388608 bytes/session, 16 sessions/agent and
86400000 ms maximum sendable age. Existing positive-decimal settings
`AIFY_ACTIVITY_SESSION_BYTES`, `AIFY_ACTIVITY_MAX_SESSIONS` and
`AIFY_ACTIVITY_MAX_AGE_MS` can lower them. Every line carries the validated policy
used for that append. No process environment or first-poll timestamp can replace
it. Different policy lines do not mutate old policy; consumers enforce each line's
original policy and any stricter local limit.

## Writes and uncertainty

`new ActivitySpool({directory,...policy}).append(record)` is producer-only.
Import and construction do no filesystem work. Validation precedes root creation.
An admitted event stats its segment, checks the byte allowance, then makes exactly
one `O_APPEND` write of the full envelope plus LF. There is no SQLite, lock, control
file, fsync, cursor, ACK, repair, compactor or gap-ID ledger. The old `read`, `resolve`
and `ack` methods are removed, not retained as an alternate queue.

Only creation of a new source/session counts existing admitted segments. Byte and
session limits are best effort: concurrent processes can race after stat/count.
This is not the old hard locked budget or a physical allocation guarantee.

An existing segment's overflow or failed/partial append creates at most one
`session-<same hash>.loss` containing one `?` byte. Later append refuses that
segment. Session exhaustion, an oversized first line, invalid clock or a failure
before session admission uses the single root-wide `uncertain` byte instead.
Repeated losses do not create per-event files. Markers never contain raw identity.
The producer never removes a marker or truncates/retries a partial event line.
A crash can leave torn bytes without a marker; the reader must recognize them.
Storage failure may prevent even the marker. No power-loss durability is claimed.

## Required consumer behavior

Validate the envelope, policy, record and complete-source hash before trusting a
line. Malformed data or an incomplete LF-terminated record becomes a gap, never
successful empty history. Preserve immutable event IDs and bodies on every retry.
Use the original pre-append clocks as a conservative age origin, never first poll,
restart, observation time or resend. Expire at the original maximum age or sooner.
A rollback, reboot, invalid clock or wall/uptime elapsed disagreement beyond 2000 ms
means unknown age and a gap, not renewed freshness. Keep cross-poll clock continuity
in consumer state. Arbitrary undetectable clock changes remain unqualified.

A retained `.loss` means persistent source uncertainty; `uncertain` means root-wide
unknown producer coverage without fabricating an unretained source. Neither an old
nor a new ACK erases these latches. Retain marked segments with their markers so
consumer retirement cannot create an unbounded collection of orphan markers.
Unmarked segments may be retired only under the consumer's concurrent-reader/writer
and immutable-prefix identity rules. A deterministic filename is not a fresh segment
identity and never authorizes applying an old cursor to replacement bytes.

The shipper's bounded per-batch state owns stable gap IDs/generations, exact committed
ACK validation, contiguous-prefix advancement, refusal/conflict recovery, crash
reopen and safe retirement. No wrapper consumer API implements those obligations.
The former hard-lock, cursor, ACK, age enforcement and recovery tests are removed
from this producer suite and require env-owned replacements. Producer tests cover
the retained raw bytes and markers, not successful delivery or consumer recovery.

Actual Claude callback timing, real shipper/dashboard composition, Linux/WSL runtime
qualification and activation remain separate. Synthetic native-hook tests establish
none of those. No new credentials, discovery path, dependency or engine pin is added.
