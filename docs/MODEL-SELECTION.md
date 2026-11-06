# Explicit Claude model selections

The wrapper reports explicit launch arguments and completed native `/model` choices to aify-env. Env alone changes an existing definition's model through its model-only compare-and-swap path. This does not switch a running model.

**Qualification:** the producer is exercised through rendered launchers and isolated native-runtime fixtures. Current native-version picker, typed-command, fresh-file creation, transcript flush and exit delivery still require joint-switch qualification. A passing fixture is not a live rollout.

## Producer and launch boundary

`bin/aify-model-selection.sh` adds synchronous scan hooks without replacing session capture, turn-start, Herdr or activity hooks. `bin/aify-model-selection.mjs` delegates to `ModelSelectionReporter`; initialization runs after the actual matching lease claim and lifetime admission, before the runtime. A lifetime marker enables its hook helpers. `--check`, preliminary `--shared`, anonymous and unclaimed starts initialize no producer. Old installed launcher text does not activate a new helper by itself; new launchers tolerate a partial helper directory.

The owner-only session folder holds `model-selection.json`: current lifetime, frozen catalog projection, exact native path/domain and cursor. It contains no service credentials, definition copy, report queue or selection journal. Existing file locking serializes cursor claims; HTTP runs after the lock releases. Stale lifetime/lease owners cannot update the current cursor.

## Native witness and fence

Hooks only trigger scans. The witness is an exact supported non-meta, non-sidechain user or system/local-command `/model` command/completion pair in the same native session. The backticked `Set model to` completion must have a native UUID and the expected pairing fields. Cancel, failure, quoted prose, assistant/request models and unsupported shapes do not identify selections. Recognized but unmapped values remain unresolved rather than guessed.

- Known resume file: capture its byte length before the native process starts. Its old records and any partial line already at the fence are excluded.
- Fresh launch with no resume/continue/fork/session-id selector or computed handle: synchronous SessionStart binds its exact target. An existing file is fenced at its current length. An absent file is bound at zero; no file/directory is created by binding. When that same target appears, scanning starts at zero and fixes its native file identity.
- Resume/continue/explicit handle: an absent file cannot acquire a zero fence. Forks are disabled because their transcript can contain copied history.
- Later native session/path changes, replacement, truncation, rewritten boundary bytes or an unreadable identity refuse rather than resetting history. A file absent at fresh binding may remain absent until its first record; once identified it cannot be rebound.

SessionStart, UserPromptSubmit, Stop, PostModelSwitch and SessionEnd use the same incremental whole-line scan. Normal wrapper EXIT performs a final best-effort drain before releasing lifetime/lease ownership, preserving the runtime's exit status. Each scan selects the latest complete native record, identified and ordered by its newline-terminated byte END offset, never by callback time, displayed value or UUID sorting. Distinct same-value picks are not deduplicated.

## Literal values and settings precedence

The launch report uses only the original explicit `--model VALUE` or `--model=VALUE`, not a definition/default added by the launcher. Missing/option-shaped values are not choices.

For native completions, resolve a replacing `modelPicker` catalog once at launch: forwarded parseable `--managed-settings` JSON, otherwise observable local managed policy, otherwise selected user config. Managed sources that cannot be resolved remain unresolved. Local registry reads use a one-second per-command timeout; a timeout stays unresolved instead of falling back to user data. The generated hook settings must contain no picker. Duplicate model IDs/labels, unsafe/reserved labels, padded strings and unknown sources do not yield an inverse mapping. A picker label must match exactly one row; typed arguments must equal a declared model value or one unique label. Native Default is `""`; unresolved is null. Shared `settings.model` and subsequent request models are not selection receipts.

Any operator-forwarded ordinary `--settings` disables model-command reporting with one visible launch line, retaining the explicit launch report. Native settings order and operator semantics remain unchanged; this does not repair the separate pre-existing hook-carrier displacement limitation. `/config`, fast mode, forks and later native-session switches produce no model-command update; an explicit launch argument is still reported.

The projection is frozen for this lifetime. Remote/unobservable policy, unsupported catalogs and mid-session catalog edits are not universally qualified.

## Environment request contract

`POST /agents/:id/model-selection` uses the current instance's local descriptor under the selected home, a bare HTTP IPv4 loopback origin, no service credentials, no redirect following and a two-second transport deadline. Exactly these fields leave the producer:

| Field | Launch | Native completion |
|---|---|---|
| instance | Current env instance or held residents role | Same |
| lifetime | Current lifetime UUID | Same |
| harness | `"claude"` | `"claude"` |
| source | `"launch"` | `"model-command"` |
| session | `""` | Native session UUID |
| transcriptIdentity | null | Stable opaque native-file identity (producer SHA-256) |
| endOffset | null | Positive safe-integer native byte END offset |
| recordUuid | null | Native completion UUID |
| value | Exact explicit argument, or null | Literal catalog model, `""` Default, or null unresolved |

Env admits the current identity before ordering or writes. Launch is admitted at most once and never after an admitted completion. The first completion binds the session/file domain for the lifetime. Higher offsets are eligible; exact duplicates are idempotent; older or conflicting same-position events cannot write another value. Advance the in-memory high water before compare-and-swap, including unresolved values and failed newer writes. Every eligible resolved re-pick rereads the current definition, so repeated A reasserts A after an external edit to B. Missing/invalid definitions are never created. Only an actual model change emits a change warning.

The receiver's fence is memory-only and resets on restart. Domain binding does not independently attest native files; the producer owns parsing, launch fencing and continuity. See the environment repository's `docs/MODEL-SELECTION-v1.md` for the receiver-owned contract.

## Limits and checks

A failed POST logs locally once for that attempt; the native position is consumed, with no queued retry or replay. Hard kills, transport loss and unsupported commands cannot guarantee final delivery. Reporting failure does not fail the useful native launch.

`tests/model-selection-launch.test.js` executes the real rendered launcher into a sealed runtime that fires the registered effective hook commands, including absent fresh files, resumed history, Herdr/activity Stop composition, forwarded settings and EXIT-only delivery. The reporter, parser/catalog/cursor and transport test files cover the value, identity and continuity guards. These fixtures never run a real agent runtime or start an environment daemon.
