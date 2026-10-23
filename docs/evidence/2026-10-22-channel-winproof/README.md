# The per-user channel policy on Windows (2026-10-22)

## (a) The registry read, merge and write: proven against a scratch key

`probe.mjs` runs the real adapters and the real merge (`planInstall`) against `HKCU\Software\aify-test-<random>` on
this host's registry (Windows 11, not elevated), then deletes the key and reads it back absent. The operator's
`HKCU\SOFTWARE\Policies\ClaudeCode` and every HKLM key were only read, and both are absent on this host
(`reg query`, exit 1, before and after; the same query listed `HKCU\SOFTWARE\Policies\Microsoft`).

| case | on d4a6c80 (`run1-on-d4a6c80.txt`) | fixed (`run2-fixed.txt`) |
|---|---|---|
| absent value written, read back, idempotent rerun | pass | pass |
| unicode and quoting round trip | **fail**: `reg query` prints through the console code page, so `naïve ключ` came back `naive ????` with exit 0 | pass |
| foreign keys and a foreign allowlist entry kept | **fail**: the altered text above was written back over the policy | pass |
| another value under the same key kept | **fail**: `New-Item -Force` on an existing key deleted its other values | pass |
| malformed value refused, left as it was | pass | pass |
| a `Settings` of another type (REG_EXPAND_SZ) | **fail**: read as absent, then replaced | refused |
| pretty-printed JSON (newlines, a line opening with `[`) | **fail**: `reg query` returns its first line only | pass |
| an admin policy in charge refuses the write | pass | pass |
| the real HKLM key read as absent | pass | pass |

The fix (`lib/channel-policy.mjs`): read with `reg export`, which writes UTF-16 to a temporary file; parse the key's
own section; write through `[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey`, which opens an existing key as
it is. A source it cannot read, a non-string `Settings`, an unreadable admin file, and a `managed-settings.d`
directory holding policy files all refuse the install rather than read as absent. `mutations.txt`: eight mutants,
each killed by the test named for it.

## (b) What Claude Code does with that value: documented, not run on this host

Sources, read 2026-10-22:
- code.claude.com/docs/en/managed-settings, "Where each mechanism stores the policy": HKCU holds "the same
  `Settings` value under `HKCU\SOFTWARE\Policies\ClaudeCode`"; HKLM takes "the JSON as a `REG_SZ` or
  `REG_EXPAND_SZ` value named `Settings`".
- Same page, "How Claude Code combines managed sources": the order is remote (server-managed) settings, then the
  HKLM key, then `managed-settings.json` with `managed-settings.d/*.json`, then HKCU, which Claude Code "reads only
  when no admin document is present above it". An admin document is present when it sets any policy key, or exists
  but cannot be read. d4a6c80 did not know `managed-settings.d`; this branch adds it.
- Same page: HKCU is "Read at startup and checked for changes every 30 minutes"; "A malformed value in the
  user-writable HKCU registry key never blocks launch".
- code.claude.com/docs/en/channels, "Enterprise controls": `allowedChannelPlugins` "Replaces the Anthropic-maintained
  list when set" and requires `channelsEnabled: true`; a plugin not on it means "Claude Code starts normally but the
  channel doesn't register". It also says "Pro and Max users without an organization skip these checks entirely".

**The open risk.** This host's login is `organizationType: "claude_max"` (read from `~/.claude.json`, no secret
printed). The docs sentence above can be read as "a Max login ignores `allowedChannelPlugins`", in which case
only Anthropic's own list applies, the aify plugin does not register, and an agent on the plugin route starts deaf
with only a startup notice. The aify-comms channel proof (`docs/evidence/2026-10-22-channel-proof`) read the 2.1.308
binary and found `allowedChannelPlugins` taken with no account-type check, but ran with a fake key. The host runs
Claude Code 2.1.307, not the 2.1.308 that was proven. Nothing here settles it: the go-live check below does.

## Go-live check (the operator's next ordinary relaunch)

Before the install chain writes the policy:
1. Save what is there: `reg export "HKCU\SOFTWARE\Policies\ClaudeCode" "%USERPROFILE%\.aify\backups\claude-policy-<date>.reg" /y`.
   Exit 1 with "unable to find" means there was nothing; write that down instead.

After it writes:
2. `node lib/channel-install.mjs check --bridge-dir <bridge>` prints `route: plugin` and
   `policy source: HKCU\SOFTWARE\Policies\ClaudeCode`.
3. In ONE relaunched resident, read only:
   - no "WARNING: Loading development channels" dialog;
   - the startup channels notice has no "not on the approved channels allowlist" and no "waiting for your
     organization's policy";
   - `/status`: the `Setting sources` line shows `Enterprise managed settings (HKCU)`;
   - a comms message to it arrives in its transcript as `<channel source="plugin:aify-channel:aify-comms-channel"`,
     and the run is claimed by it (comms `comms_run_status`).
4. Only then relaunch the rest.

Rollback, if any line in step 3 fails:
- there was a saved value: `reg import "%USERPROFILE%\.aify\backups\claude-policy-<date>.reg"` (it replaces
  `Settings` with the saved one);
- there was none: `node lib/channel-install.mjs remove` (takes out our entry, and the value when nothing else is in
  it);
- then `node lib/channel-install.mjs check` must print `route: dev`. The next relaunch takes the development route
  with its prompt, which is today's behaviour.
