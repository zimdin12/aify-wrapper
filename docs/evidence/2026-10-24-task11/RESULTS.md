# Task #11 qualification

2026-10-24. **NOT GREEN as a five-suite composition. Awaiting source review and gap disposition.**

Base `e103f3d6dbfe0173352671eb76642a575b05cdd8`.
Qualified source/test/doc tree `0d076ece4df68f0dd7c62326174000e130f1b626`.
The final review request names its evidence-inclusive successor. No source commit, push, live
registry write, elevation, route switch or runtime restart was performed for this task.

## Change

The failed Windows policy-write result retains exit 78 and its original error and steps. It now
prints a one-time command for PowerShell as Administrator under the same Windows account. The
command quotes each argument, doubles embedded apostrophes and names the absolute Node executable,
installer module and bridge directory. It does not elevate or execute the command.

The policy header and current README no longer say HKCU needs no admin. They distinguish per-user
policy precedence from write permission. The policy implementation after its header is byte-identical
to base. Registry adapters, merge rules, install order, malformed/admin-source refusals and already
admitted no-write behavior remain unchanged. The README was already 493 lines across the launchers;
this change stays in its existing channel-install section.

## Direct proof

- `red.txt`: the actual native CLI exited 78, reached exactly one denied write fixture, rendered no
  plugin files, and failed specifically because its refusal omitted the elevated instruction.
  The same CLI's read-only check first reached `route: dev` without a write.
- `focused.txt`: 51 tests passed, none skipped, across the new regression and four existing affected
  files. The new test uses the real install entry and adapters, with all registry subprocesses stubbed.
  Native PowerShell parsed the printed command without executing it. Its recovered argv exactly matched
  the intended paths and arguments, including a bridge path containing spaces, an apostrophe and `&`.
  The same parser rejected known-invalid syntax.
- `quote-mutant.json` and `quote-mutant.txt`: removing the apostrophe escape in a private export of the
  exact source tree failed the parser's errors=0 assertion, actual 2. The campaign checkout was never
  mutated, and the export was restored byte-for-byte.
- `source-binding.json`: the five payload files matched the qualified index bytes. `static-scan.json`
  records controlled added-line scans. `artifact-check.json` records its bounded environment-value scan.

The initial temporary-root setup error is retained in `harness-setup-failure.txt`. It reached no test
and is not the feature RED. Corrected runs use an explicit owned Hermes scratch root.

## One complete campaign

`run_full_suites.py` reused the existing sequential gate layout. `full/receipt.json` records native
exits, argv, cwd, interpreter, shell, temp/import/repository pins, coordinator PID and creation time,
source populations before/after and all seven raw log hashes. Sources stayed unchanged. The parser
verified every recorded log hash before producing `full/parsed-results.json`.

| Invocation | Exit | Actual reporter result |
|---|---:|---|
| Baseline bridge | 1 | 380 unique file invocations, one failed file |
| Baseline env | 1 | 3441 passed, 2 failed, 4 skipped |
| Candidate Python | 0 | 5736 passed, 28 skipped, 12638 passed subtests, 10 warnings |
| Candidate bridge | 1 | 380 unique file invocations, one failed file |
| Candidate dashboard | 0 | 1953 passed, none skipped |
| Candidate wrapper | 0 | 937 passed, 70 skipped; new native CLI regression ran and passed |
| Candidate env | 1 | 3442 passed, 1 failed, 4 skipped |

The bridge arms fail the same file, `bridge-exits-when-its-terminal-goes.test.js`, and the same case,
`a resident bridge whose stdin ends reports resident-lost and exits`, at line 77, expected 1, actual 0.
That is a matched baseline failure relative to this wrapper change, not a root-cause diagnosis.

The env failures differ. Baseline fails `a-second-start-supersedes-the-first.test.js` at its superseded
instance assertion and reports a file-level failure for `the-launcher-and-aify-env-name-one-home.test.js`.
The captured file-level report supplies no individual-case outcome or underlying assertion.
Candidate fails `herdr-identity.test.js`, `final shipped attach --id refuses label collision, ordinary
label still resolves`, line 63. The human attach's captured stderr was empty instead of naming terminal
validation. These failures remain **UNATTRIBUTED**.

Exactly one named-file control per arm ran those three env files with the recorded campaign pins.
Both arms passed 10 tests, none skipped, with unchanged source populations. This is non-reproduction,
not attribution to timing, load or any other cause. No full campaign was repeated.

## Consumer and permission limits

The wrapper suite exercised the changed CLI from this worktree. Repository-aware fixtures used
`AIFY_WRAPPER_REPO` for the candidate or base arm. The service's bundled wrapper installer still
matches base bytes, as recorded in `artifact-check.json`; its package pin was not changed. The other
suites are regression checks, not proof that a deployed service consumes the new refusal.

The protected Policies ACL was not changed or probed with a write. Its denied-write premise comes
from the task's 2026-10-23 go-live observation. The historical winproof scratch-key experiment does
not prove that ACL. Executing the suggested elevated command and live activation remain operator
work outside this task's authority.
