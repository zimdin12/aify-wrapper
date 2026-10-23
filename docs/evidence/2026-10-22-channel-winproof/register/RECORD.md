# One host run of `--channels plugin:aify-channel@aify-local` (2026-10-22), stopped

## What ran, and when

One arm of `../register-probe.mjs`, `channels-aify-local`, from about 23:27:44 to 23:28:10 local time (+03:00), in
`C:/Docker/apg-ab-arms/ws-7f2a` (marked trusted in `~/.claude.json`, no `.mcp.json`). Claude Code 2.1.307, on the
operator's Claude Max login, with no policy written. `channels-aify-local.cmd.txt` holds the exact command and the
environment variables removed (every AIFY_*, HERDR_* and CLAUDE*).

- The plugin was loaded for the session only (`--plugin-dir`), with `--strict-mcp-config` and an empty
  `--mcp-config`. Its server declares the channel capability and pushes nothing. It wrote no log, so it did not
  start, or was not started.
- No prompt was sent. The probe typed `/exit`. No transcript was written for that folder, so no model turn was
  recorded.
- The probe script hung after its capture, and its exact node pid was stopped. The claude process had exited, and
  no probe process remained.

This ran before the operator answered. The answer was no host claude test now: it is tested at go-live. The second
arm (the development-flag control) did not run.

## Observed (PROVEN, `channels-aify-local.screen.txt`)

```
Channels (experimental) messages from plugin:aify-channel@aify-local inject directly in this session · restart without --channels to stop
plugin:aify-channel@aify-local · plugin not installed
plugin:aify-channel@aify-local · not on the approved channels allowlist
```

## What it does not settle

A `--plugin-dir` plugin registers under the marketplace `inline` (Claude created `plugins/data/aify-channel-inline`),
not `aify-local`. So "plugin not installed" is expected, and "not on the approved channels allowlist" shows only that
the allowlist check runs on this Max login for `aify-local`. Whether an installed `aify-local` plugin registers once
the per-user policy lists it is untested: the go-live check in `../README.md` tests it.

## Files touched on the host

- `~/.claude.json`, written by Claude at start: numStartups, the project entry for the folder above,
  lastReleaseNotesSeen, cachedGrowthBook*, changelogLastFetched, clientDataCacheSlots, promptQueueUseCount,
  lastClawdEntranceVersion, additionalModelOptionsAnsweredAt and pluginUsage changed. It still parses. It was not
  reverted, because other agents write it.
- `~/.claude/plugins/data/aify-channel-inline/`, empty: removed afterwards with rmdir and read back absent.
- Under `~/.claude/plugins/store` and `~/.claude/plugins/synced`, files newer than the run's start. These are Claude's
  plugin sync, from this run or another session; they were not touched.
- `~/.claude/settings.json` unchanged (same sha256 prefix before and after); `HKCU\SOFTWARE\Policies\ClaudeCode`
  absent before and after.
