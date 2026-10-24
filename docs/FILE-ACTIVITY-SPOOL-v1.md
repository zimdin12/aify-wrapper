# Claude named-file activity and spool v1

This is the wrapper producer/consumer contract. It does not enable activity, install a shipper, or claim complete file history. The dashboard's `FILE-ACTIVITY-CONTRACT-v1.md` owns HTTP validation and ACK semantics. The env plugin owns network delivery. Code review and activation remain separate.

## Enablement and identity

`AIFY_FILE_ACTIVITY=1` opts a Claude launcher into the local producer. Absence or `0` is off. Other values are invalid. This is a direct, validated opt-in, independent of any Herdr claim or pane. It is not automatically injected by the env plugin's secrets-only `spawnEnv` contribution.

With activity enabled, each rendered `PostToolUse` and `PostToolUseFailure` contains one command:

```text
node --disable-warning=ExperimentalWarning "<wrapper>/bin/aify-tool-event.mjs" success
node --disable-warning=ExperimentalWarning "<wrapper>/bin/aify-tool-event.mjs" failure
```

These are the two event variants, not commands to run together. There is no observer beside the old state hook and no JSON-parser child. The process reports existing working state independently, then parses stdin and appends locally. It imports no HTTP client and makes no network call. Herdr reporting may start the existing native Herdr executable. Activity-off commands and non-tool callers retain the original shell. Codex's commands and trust calculations are unchanged. Both SessionStart commands, session capture and `resident-started claude`, remain installed.

The admitted specimen is Claude's top-level `session_id`, `cwd`, `tool_name`, optional `tool_use_id`, and `tool_input.file_path`. Only Read, Write and Edit are supported. Read means `read`; Write/Edit mean `write`. Failure means an attempted operation, not a successful write. Bash, command strings, contents, diffs, responses and error text are not recorded. No transcript or latest-session lookup exists. Child/parent identity fields cause refusal because subagent attribution has not been qualified.

Agent identity is the current `AIFY_AGENT_ID`; instance is the current `AIFY_ENV_INSTANCE`; incarnation is `AIFY_LIFETIME` or null. Agent, instance, machine and session identity are required. Missing identity never borrows a parent. `machineIdFor` remains the shared host rule. Paths are normalized lexically using the supplied host cwd. No file-existence lookup, realpath, or file-content read occurs. WSL facts are not captured in v1. Consumers must omit `wsl`, rather than add changing facts on retries. WSL alias placement remains unqualified.

## Exact admitted root

Resolve the state root through the existing wrapper `leaseDirectory({env})` owner: `AIFY_AGENT_LEASE_DIR`, otherwise the wrapper host's `~/.aify/agents`. The root must be absolute. The producer uses:

```text
<leaseDirectory>/<validated AIFY_AGENT_ID>/activity-v1/
```

The env consumer must receive that same absolute lease-directory value as configuration, or reuse the owner with the same host environment. Definitions/watch roots do not establish a lease directory. Do not invent another home scan or infer the root from a project folder. Discover only admitted agent IDs and their `activity-v1` child; do not read runtime transcripts or lease-record contents as activity data. Agent IDs are validated as bounded single filename segments. Session IDs are never joined into paths.

The directory must be privately owned by the local producer/consumer. Admission refuses pre-existing symlinks/junctions in the root or ancestors, unsafe files and unowned entries. It does not delete external data. This is qualified for cooperating local writers, not a hostile same-user process replacing ancestors concurrently with admission.

## Immutable line and disk layout

One UTF-8 JSON line is one complete event. The fixed event ID and record body are generated once before the first append and reused by the reader, never regenerated for retries.

```text
{version:1, adapter:"claude-file-path-v1", source:{machineId,instanceId,agentId,
 incarnation,runtime:"claude",sessionId}, event:{eventId,tool,toolCallId,
 operation,outcome,observedAt,path:{raw,canonical}}}
```

`toolCallId` and `incarnation` may be null. Outcomes use the HTTP spelling `success`, `failure`, `unknown`; installed Claude commands emit the first two only. Times are integer Unix milliseconds. IDs use lowercase UUID spelling. No extra fields survive extraction. Ship `record.event`, not the storage envelope or raw stdin.

Files in the directory are:

- `slot-0.jsonl` through `slot-15.jsonl`, each with one immutable segment UUID in control metadata. A retained slot belongs to one exact source/session.
- `control`, a fixed 262144-byte padded JSON document containing version, root UUID, policy, generation, first-append clocks, slot identities, byte cursors, loss markers and bounded conflict dispositions.
- `control.tmp`, a second fixed-size document used for atomic publication.
- `mutex.sqlite` and its rollback journal. SQLite is used only for the local cross-process critical section, never for event storage. `BEGIN IMMEDIATE` is released by the OS when a writer exits. There is no lock child, stale-PID deletion or time-based lock stealing.
- `uncertain`, an optional one-byte permanent root-wide coverage-unknown latch. No ACK clears it.

`ActivitySpool` in `lib/activity-spool.mjs` is the supported consumer API. Importing the module performs no filesystem work. Its storage helper is internal. Use the API instead of editing control or independently tailing/deleting segments.

## Bounds, age and crashes

Configuration defaults and inclusive upper bounds are 8388608 bytes/session, 16 retained source/session slots per agent, and 86400000 ms maximum sendable age. Optional lower values are positive decimal integers in `AIFY_ACTIVITY_SESSION_BYTES`, `AIFY_ACTIVITY_MAX_SESSIONS`, `AIFY_ACTIVITY_MAX_AGE_MS`. The first writer persists policy; another writer or reader with different policy refuses instead of silently changing budgets.

The declared logical content bound is:

```text
sessionBytes * maxSessions + 2 * 262144 + 32768 + 1
```

At defaults this is 134774785 bytes per admitted agent root. The 32768-byte allowance includes the fixed mutex database and rollback journal. Gap, cursor and recovery metadata are inside the two control files. This is not a physical filesystem allocation, directory-entry or filesystem-journal bound.

A single OS-released transaction covers checking the shared budget and one complete `O_APPEND` event-line write. No HTTP or native child runs in that critical section. The writer fsyncs the line and control publications. A killed writer cannot leave an orphan lock. An interrupted append truncates only its uncommitted tail back to the previously committed byte count and latches an interrupted gap. Its old prefix, cursor and conflict marker IDs remain intact. Unexpected size, invalid line, torn tail or expiry yields a bounded durable source-qualified gap before a cursor can retire that data. An initial incomplete `control.tmp` with no segments recovers with root-wide unknown coverage. Unreadable/corrupt control or unowned data fails closed as unknown, without guessing identity or deleting data.

ACK publication is one atomic control replacement, not a pending append. It either preserves the prior dispositions or publishes the committed cursor/marker state. A terminal slot is published as retired before deleting its data. If interrupted, the next operation finishes that exact retirement before reusing the slot. Other sessions and existing conflict recovery do not become append losses because an ACK process exited.

Age starts conservatively at the first append of a retained segment, never at observation time, retry, reopen or resend. Later records in that segment can expire earlier than their own 24-hour deadline. Wall/uptime rollback and disagreement beyond the two-second sampling tolerance produce a clock gap. Expired data is no longer returned as events; its bytes may remain inert until the gap ACK permits removal. There is no claim of power-loss, storage-hardware or arbitrary clock correctness from O_APPEND/fsync alone.

When an admitted session fills, its bounded loss marker gets a fresh generation/ID on new loss. A late ACK cannot clear its replacement. If all session slots are occupied, the producer retains no extra session identity and sets the root-wide unknown latch. This avoids exceeding the session bound or falsely attributing the new session's loss to a retained one. The shipper reports unknown producer coverage for sources read from a latched root. It does not fabricate a source for an unretained session. Disk/permission failure can prevent even the latch; durable coverage is then not guaranteed. Missing, cancelled or rejected callbacks remain unknown, not a verified empty history.

## Consumer protocol

Construct `new ActivitySpool({directory, sessionBytes, maxSessions, maxAgeMs})` with the same policy. Default clock functions are `Date.now` and host uptime. `lockWaitMs` defaults to 250 and is bounded at 3000; lock/storage refusal returns `{ok:false,reason,coverage:"unknown"}`.

1. Call `read()`. It returns `{ok,version,source,records,gaps,gap,generation,coverage,token}`. `records` contains `{record,end}` entries. `gap` is a convenience alias for the first gap. A normal read returns at most 128 records, 200 KiB of stored lines and 32 pending gaps, for one source. `source:null, token:null` means no sendable batch, not complete history. The token binds the root UUID, generation, exact segment UUID/index, start/end offsets, SHA-256 of the immutable prefix and exact event/gap ID lists. Preserve it unchanged.
2. Send a new HTTP batch with `source`, `records.map(x=>x.record.event)` and coverage `{generation,producer:coverage,reportEveryMs:null,gaps}`. Use a new `batchId` for a new request. Preserve every event/gap ID and body. The plugin must first find the enabled `fixed.fileActivity` declaration through existing service discovery. The wrapper registry/spec admit only `{path:"/api/v1/file-activity"}`. Its absence authorizes no trial POST. Resolve credentials using the existing service credential owner; no key belongs in the spool.
3. Validate the HTTP 200 and its exact batch ID, ordered event results, committed generation and acknowledged gap IDs according to the dashboard contract. A transport/auth failure, malformed ACK or 409 is not an ACK.
4. For terminal refused results, first call `resolve(token,{eventIds:[refused IDs],reason:"refused"})`. For a validated 409, call `resolve(token,{eventIds:[named conflicting event IDs],gapIds:[named conflicting gap IDs],reason:"event_conflict"})`, or `reason:"gap_conflict"` for a gap-only conflict. Validate all server IDs belong to the submitted batch first. This method also checks membership locally. It durably creates a stable fresh marker for each excluded event. Conflicting gap IDs are replaced with stable fresh `gap_conflict` markers. The 409 itself advances no cursor.
5. Read again and resubmit unaffected records plus pending recovery gaps with a fresh batch ID. Previously stored unaffected events may return duplicate. Recovery never requires whole-queue discard. It keeps excluded IDs and replacement marker IDs through restart. If a smaller requested `maxRecords`/`maxBytes` cannot cover the frozen recovery prefix, read refuses `recovery-read-limit` without issuing an ACK token. Retry with the normal limits. There is no partial-prefix token that could retire unseen recovery obligations.
6. Only after a validated committed ACK call `ack(token,{committed:true,eventIds:token.eventIds,gapIds:token.gapIds})`. Lists must match exactly. This API trusts the shipper's validated commit assertion; it does not perform HTTP. If more than 32 recovery markers are pending, ACK pages drain them durably while `advanced:false` keeps the event prefix. Unaffected records can be resent unchanged between pages. The cursor advances only once all excluded-event gap obligations in the frozen prefix are committed. Reopen after a crash and read again; duplicate delivery is safe. Old generations, reused slot filenames or changed prefix contents refuse advancement.

Terminal refusal/conflict metadata is bounded, durable and visible to the shipper until a committed gap ACK permits retirement. It is not an unbounded local audit log. Server gap visibility after ingestion belongs to the HTTP contract and the env/dashboard composed proof.

## Qualification and remaining scope

The focused proof executes actual rendered commands against private native sinks, including native Windows paths with spaces and MSYS conversion on/off. It is not a live Claude session, a deployment, or a new timing measurement. Node 22.20.0 is the host-runtime gate; Node 26.7.0 is additional coverage. Hook commands resolve `node` from their own PATH. Test invocation alone does not upgrade or select a host's production Node.

See `docs/evidence/activity-6/README.md` for exact commands, raw byte bindings, compiling guard plants and version-bound results. Hermes/Codex file producers, subagent attribution, WSL alias placement, Linux runtime execution, physical disk allocation, power-cut durability and remote delivery remain unqualified here. The parent owns final cross-repository composition, code-review handoff and any activation decision.
