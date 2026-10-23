# Channel final review of a32b385: CR1-CR6

aify-comms review 1792722473099-5a0d08b5, report `channel-successor-1792707980509/REVIEW.md`. The comms producer
(5101fb3b) is unchanged. Every command ran in this worktree through `npm test -- <files>`. Nothing here ran claude,
read or wrote the real per-user or admin policy, or touched ~/.claude.

## What changed

- **CR1, one producer on the route returned.** `lib/channel-route.mjs`:
  - `roleOf` and `produces` restate aify-comms' `channel-producer.mjs` rule.
  - The plugin route refuses a configured server that runs the plugin's entry, wherever it lives.
  - The development route is refused (`none`) when a plugin-role server would still produce on it (`devConflict`): the
    installed plugin's own server routed `plugin`, or a configured plugin-entry server routed the same way.
  - An `AIFY_CHANNEL_ROUTE` spelled twice with different values is refused, not guessed.
- **CR2, a usable provider.**
  - `devProvider` counts only the record Claude would start: local over project over user.
  - It does not count a record running the plugin's entry.
  - Strict mode, which bypasses the route check, now refuses with the repair when the bridge has no `claude-channel.js`
    (`wrappers/claude-aify.sh.in`).
- **CR3, explicit disabling.**
  - `routeHere` reads the folder's `disabledMcpServers` and `disabledMcpjsonServers`, and the settings files'
    `disabledMcpjsonServers`.
  - A disabled named provider is not one.
  - A disabled name that may be the plugin's server (it contains `aify-comms-channel` or `aify-channel`) declines the
    plugin route. How Claude spells a plugin server in that list was not read, so the match is loose and declines.
- **CR4, readiness.**
  - An unreadable plugin entry is not ready, in `gateOf` and in `pluginBlocker`.
  - The manifest must carry the rendered `name`.
  - A settings file present but not a JSON object declines the plugin.
- **CR5, unknown admin location.** `effectivePolicy` answers an `unknown` admin source as unreadable, never absent.
  `routeHere` passes its `env` through.
- **CR6, controls that reach their branch.**
  - `installChannel` takes `env`. The lowercase-DWORD test passes a known Program Files, so its refusal is the DWORD's,
    and asserts it unconditionally.
  - With `env: {}` it reaches the unknown-location refusal, with zero writes either way. Windows hands every process a
    ProgramFiles, so only an explicit `env` can say none.
  - Added: a case-varied `settings` with foreign content beside a sibling value, read, merged and recorded as one HKCU
    write keeping the foreign keys; and the admitting-base with and without drop-ins, through `routeHere`.
- **Fixtures.** Healthy fixtures carry the rendered manifest `name`. The launcher test gets a known, empty Program
  Files. The strict-mode render tests get a `claude-channel.js` in their bridge.

## Evidence

- `red-keeps-one-producer-on-a32b385.txt`: the new test file on unchanged a32b385. 13 tests, 2 pass, 11 fail. Each
  failing test's first error line is kept. The two passes are the healthy controls.
- `red-strict-launcher-on-a32b385.txt`: the launcher test with a32b385's launcher. The strict case fails first on exit
  status (0, not 78).
- `red-declines-on-a32b385.txt`: the changed declines file with a32b385's three modules. It fails on the empty-env
  unknown-location assertion. The S1-history and routeHere S2 histories pass there too: they are regression controls
  for repairs already in a32b385, not new behaviour.
- `mutants.txt`: 14 arms, one edit each, restored from a byte copy and compared equal after each. The first failing
  test and its first error line are recorded.
  - **M14 SURVIVED** on the first run: the test then passed a known Program Files only, and Windows supplies one to
    every process, so ignoring `env` changed nothing. The test now also passes `env: {}`. The rerun, M14b, fails on the
    DWORD reason where the unknown-location one was expected.
  - **M10's first failure is a TypeError**, not an assertion: the mutated code dereferences the unparsed settings.
- `full-suite-first.txt`: the first full run, npm exit 1, 6 failures. The every-export check named four new exports with
  no test. Five strict-mode render tests had a bridge with no `claude-channel.js`, which the new strict refusal now
  stops. Both are fixed in the commit.
- `full-suite-final.txt`: npm exit 0. 989 tests, 923 pass, 0 fail, 66 skipped.

## Not established

Native Windows behaviour of a duplicate-cased env key, Claude's own spelling of a disabled plugin server, account
applicability and the composed install remain as the review left them.
