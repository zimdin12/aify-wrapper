# Activity task 6 evidence

The consumer contract is `docs/FILE-ACTIVITY-SPOOL-v1.md`. `results.json` binds the delivery source/test bytes, runtime executables, focused/regression selections and each compiling plant's RED/restored logs. `raw-index.json` inventories retained ignored evidence under `.check-output/activity-6`. Neither JSON file substitutes for the raw observations.

Delivery results on each of Node 22.20.0 and 26.7.0: 67 focused tests passed with no skips; the affected-regression selection discovered 132, passed 126 and skipped the six pre-existing Windows Codex shell fixtures. All 35 distinct guard plants compiled, reached their named assertion RED and passed after byte-exact restoration on each runtime. Final npm script workers and emitted hook runtimes are version-bound separately.

## Portable paths

The public `results.json` is a derived view with runtime-specific placeholders for native executable, npm and shell paths. Its `portablePaths` section binds the unchanged original at `.check-output/activity-6/native-results.json`. The original remains in private custody, as do the native execution receipts. `raw-index.json` supplies their root at `.check-output/activity-6/implementation`, keeping them separate from subsequent qualification runs. Its `originalIndexSha256` binds the unchanged original index at `.check-output/activity-6/native-raw-index.json`. Source hashes, executable hashes, selections and outcomes are unchanged. The README digest describes this public revision, not the earlier implementation handoff.

## Meaning and limits

All product qualification here is PASSES IN TESTS, on native Windows. Rendered launchers execute their actual success/failure command strings with a private native sink and owned homes. The runtime is a capturing Claude stub, not a live Claude session or fleet pane. The tests cover native paths with spaces, MSYS conversion enabled/disabled, actual native claim/private-target handoff, managed and unclaimed sessions, and cap on/off. They reopen actual spool/control files for write-effect assertions.

Each selected npm script worker is bound to its observed `process.execPath` and `process.version`. The emitted hook checks the executable/version that it actually started. Node 22.20.0 is the host-runtime gate; Node 26.7.0 is additional coverage. The test invocation's PATH does not establish that a production host has changed Node versions. Executable SHA-256 bindings live in `results.json` and each raw receipt.

The affected-regression population includes registry/spec ownership, rendering, Codex hook/trust calculations, resident-start wiring, export coverage and source-size/path/heredoc gates. The six Windows skips are the pre-existing Codex shell-executable Herdr fixtures, listed verbatim in the results. They are NOT new Codex runtime or producer coverage. The legacy state shell, Codex/Hermes templates, Codex trust helper and lease/lifetime helpers are byte-bound to the supplied base. `native-suite-results.json` records the later full maintained suite against the adopted product source. Qualification with the shipper and dashboard remains separate.

No network delivery, live runtime timing, activation, WSL alias placement, Hermes/Codex/subagent producer support, physical disk allocation or power-cut durability is claimed. The capability remains opt-in/off by default. No live service was started, stopped or restarted.

## Reproduce

Use an absolute runtime executable. The helper chooses the matching npm CLI beside it, or an explicit `npm_execpath` when that installation's layout differs. On Windows it prepends the native Node directory with a semicolon, uses the actual SystemRoot's `System32/cmd.exe` as npm script shell, and verifies `cmd /d /c node --version`. On POSIX it uses the native delimiter and `/bin/sh`. All HOME, USERPROFILE, AppData and temp aliases are owned and agent/service namespaces are scrubbed before synthetic fields are added.

```text
<absolute-node22> docs/evidence/activity-6/qualify.mjs unique-focused-22
<absolute-node26> docs/evidence/activity-6/qualify.mjs unique-focused-26
```

The helper invokes the maintained `npm test -- tests/<file>...` runner, not bare `node --test`. Exact regression argv is recorded in `results.json`; pass those test files after the label to reproduce that selection. It writes the raw output, a runtime/source-bound receipt and a probe's actual worker records in its unique ignored directory. Existing labels are refused.

Run mutation controls only in an exclusively owned tree with no other source edits/tests:

```text
<absolute-node22> docs/evidence/activity-6/guard-plants.mjs unique-plants-22 --owned-tree
<absolute-node26> docs/evidence/activity-6/guard-plants.mjs unique-plants-26 --owned-tree
```

The optional last argument is a comma-separated subset of named plants. Every arm requires a healthy focused baseline, a unique exact edit anchor, successful `node --check` or `bash -n`, the preregistered named assertion RED, byte-exact restoration and a healthy restored run. Run long campaigns as tracked background jobs and await their terminal exit. A transport timeout is not a native test exit, and can interrupt `finally`; verify source hashes and owned controller state before resuming.

The plant prediction names the primary discriminator, not an exact exhaustive failure set. Broader overlapping failures are retained in the raw receipt rather than presented as additional independent coverage. The controls include secret-field leakage, each missing identity carrier independently, child ambiguity, Bash attribution, cap-off behavior, Herdr-only installation, an added parser child, both state/activity coupling directions, byte/session bounds and concurrency, one append write, orphan locks, interrupted writes, age/clock rules, root junction admission, immutable-prefix ACKs, stale gap ACKs, committed-ACK admission, terminal refusal visibility, record/gap conflict recovery, policy identity, capability validation, initialization crashes, torn tails, partial recovery reads and crash-safe ACK/retirement/prefix/marker preservation.

## Retained failures and corrections

- The migrated `pre-migration-module-missing-node22.log`, SHA-256 `e3dc89b3167cb908132776f329aa75e92778dfe2eca5707980a640d11fb0d058`, contains two missing implementation-file failures: `lib/activity-spool.mjs` and `lib/file-activity.mjs`. It is an import/setup observation, not behavioral RED and not evidence of missing Node built-ins or Node 22 incompatibility. `migration-custody.json` binds the original six draft files.
- The initial draft's focused green did not prove orphan-lock recovery or conflict-to-gap recovery. Compiling behavioral REDs were added before those changes. Launcher fixture failures for the omitted definition reader, missing copied machine-id helper and absent private channel configuration are preserved as apparatus failures, not product guards.
- Native parity found actual draft differences for empty private-pane fallback and malformed multi-decimal fired times. The unchanged predecessor shell is the independent reference; no non-tool/Codex migration was performed.
- Root policy, initialization-temp recovery and smaller recovery-read tests each failed behaviorally before their corrections. Actual rename/write fault injection then showed that the pending flag could turn an interrupted ACK or append into whole-segment recovery loss. ACK publication now uses atomic committed state and a retired-slot cleanup phase; pending append recovery preserves the old byte prefix and existing conflict markers.
- An earlier combined plant call exceeded the tool's 420-second transport capture limit during Node 26. Its controller exit remains UNKNOWN. A later Node 22 attempt reached the explicit 400-second command limit and exited 124. Completed native receipts remain intact. Source hashes were checked before resuming the missing arms under fresh labels. Final campaigns use the exact delivery bytes and the tracked job is awaited before handoff.
- Early Node 26 failed-name metadata included the reporter heading `failing tests:`. That is not a test case. The reducer filters it; original logs/receipts were retained without rewriting them.

The initial checkout setup ran `npm ci` successfully. This package has no dependencies, so that installation creates no `node_modules` directory. No installation files were fabricated.

Keep `.check-output/activity-6` when archiving or disposing this clone. A missing raw file is unavailable evidence, not a zero or a passing run. New executions reproduce behavior, not the historical bytes, UUIDs or timings.
