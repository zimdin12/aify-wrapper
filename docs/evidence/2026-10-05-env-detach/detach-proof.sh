#!/bin/bash
# A REAL run of `herdr-aify env` (aify-wrapper 0.8.6 candidate) on Windows, SEALED from the operator's fleet:
# a temporary HOME (so ~/.aify/herdr, the registry the dedicated aify-env copies, and every receipt are new and
# empty: the dedicated aify-env sees no services, advertises to nothing, supersedes nothing), env -i (no AIFY_* or
# HERDR_* from this session), and the real herdr binary. Asks: does the instance outlive its launcher, does a
# second launch join it, does a bare --stop leave it alone, does `env --stop` end it.
set -u
WRAPPER="$1"
HERDR_EXE='C:\Users\Administrator\.herdr\packages\standalone\current\herdr.exe'
T=$(mktemp -d /c/Users/Administrator/AppData/Local/Temp/hd-XXXX)
TW=$(cygpath -w "$T")
WINPATH='C:\nvm4w\nodejs;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd'
run() {
  env -i PATH="/c/nvm4w/nodejs:/usr/bin:/c/Windows/System32:/c/Windows" Path="$WINPATH" SystemRoot='C:\Windows' \
    COMSPEC='C:\Windows\System32\cmd.exe' HOME="$T" USERPROFILE="$TW" APPDATA="$TW\\AppData\\Roaming" \
    LOCALAPPDATA="$TW\\AppData\\Local" TEMP="$TW" TMP="$TW" HERDR_BIN_PATH="$HERDR_EXE" \
    node "$WRAPPER/bin/herdr-aify.mjs" "$@"
}
ask() {  # the recorded env instance's own socket: serving | not-running | unknown
  env -i PATH="/c/nvm4w/nodejs:/usr/bin" SystemRoot='C:\Windows' HOME="$T" USERPROFILE="$TW" HERDR_BIN_PATH="$HERDR_EXE" \
    node --input-type=module -e '
      import { profileOwnerState } from "file:///'"$(cygpath -m "$WRAPPER")"'/lib/herdr-owner.mjs";
      import { profilePaths, herdrServerEnv } from "file:///'"$(cygpath -m "$WRAPPER")"'/lib/herdr-profile.mjs";
      import { herdr, serverAnswer } from "file:///'"$(cygpath -m "$WRAPPER")"'/lib/herdr-cli.mjs";
      const root = process.argv[1];
      const s = await profileOwnerState(root);
      if (!s.invocation) { console.log("no-instance-recorded"); process.exit(0); }
      const p = profilePaths({ profileRoot: root, invocation: s.invocation });
      console.log(serverAnswer(herdr(["pane", "list"], { bin: process.env.HERDR_BIN_PATH, env: herdrServerEnv(process.env, p) })), s.reason, s.invocation);
    ' "$TW\\.aify\\herdr"
}
PROOF_START=$(powershell -NoProfile -Command "(Get-Date).ToString('o')")
procs() {  # herdr servers and aify-env daemons this run started; the query's own powershell excluded by name
  PROOF_START="$PROOF_START" powershell -NoProfile -Command '$t=[datetime]::Parse($env:PROOF_START); Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -gt $t -and $_.Name -ne "powershell.exe" -and ($_.CommandLine -match "herdr\.exe""? server" -or $_.CommandLine -match "aify-env\.mjs") } | ForEach-Object { "  {0} {1} {2}" -f $_.ProcessId, $_.Name, $_.CreationDate.ToString("HH:mm:ss") }'
}
echo "sealed HOME $TW"
echo "== 0. CONTROL for the lock probe: a start lock still being written (no pid) must refuse, and be seen"
mkdir -p "$T/.aify/herdr"; : > "$T/.aify/herdr/env-starting.lock"
run env --no-attach; echo "exit=$? (3 = refused)"; echo "   start lock present: $([ -e "$T/.aify/herdr/env-starting.lock" ] && echo YES || echo none); invocations: $(ls "$T/.aify/herdr/invocations" 2>/dev/null | wc -l)"
rm -f "$T/.aify/herdr/env-starting.lock"
echo "== 1. herdr-aify env --no-attach (the launcher must return and leave the instance running)"
start=$(date +%s); run env --no-attach; echo "exit=$? after $(( $(date +%s) - start ))s"
echo "   instance now: $(ask)"
inv=$(ls "$T/.aify/herdr/invocations" 2>/dev/null | head -1); echo "   invocations: $(ls "$T/.aify/herdr/invocations" | wc -l); daemon receipt ready.json: $([ -f "$T/.aify/herdr/invocations/$inv/ready.json" ] && echo present || echo ABSENT)"
sleep 5; echo "   5 s after the launcher exited: $(ask)"
echo "   POSITIVE CONTROL, processes this run started that are alive now:"; procs
echo "== 2. a second herdr-aify env --no-attach (must join, start nothing)"
run env --no-attach; echo "exit=$?"; echo "   invocations: $(ls "$T/.aify/herdr/invocations" | wc -l); start lock left behind: $([ -e "$T/.aify/herdr/env-starting.lock" ] && echo YES || echo none)"
echo "== 3. a bare herdr-aify --stop (must leave the env instance alone)"
run --stop; echo "exit=$?"; echo "   instance now: $(ask)"
echo "== 4. herdr-aify env --stop (must end it)"
run env --stop; echo "exit=$?"; echo "   instance now: $(ask)"
echo "== processes started since this proof began (herdr or aify-env), after the stop:"
procs
echo "(empty = nothing from this run is left running)"
