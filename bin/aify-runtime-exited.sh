#!/bin/sh
# Report that a launcher's runtime has exited: aify-runtime-exited.sh <bridge-dir> [herdr]
#
# WHY THIS EXISTS. Turn state comes from the runtime's own hooks, and no hook fires when the runtime
# itself goes away: killed, crashed, or its terminal closed mid-turn. The agent then reads `working`
# until something else clears it. The launcher is the parent that waits on the runtime, so it runs
# this once from its exit trap.
#
# WHAT IT SENDS. A turn-end through the bridge's agent-state-event.mjs, when AIFY_AGENT_ID is set and
# the bridge has that script (an older bridge does not, and is left alone). And `idle` to Herdr when
# the launcher says the pane is its to report to (`herdr`, the same gate the state hooks use).
#
# NEVER PRINTS, NEVER FAILS, AND RETURNS WITHIN ABOUT 3 SECONDS. It runs while the launcher exits,
# in the operator's terminal. Both reports run in the background and are waited on for a bounded
# time; one still running after that is left to finish on its own rather than holding the exit.

bridge="${1:-}"
pids=""
if [ -n "${AIFY_AGENT_ID:-}" ] && [ -n "$bridge" ] && [ -f "$bridge/agent-state-event.mjs" ]; then
  node "$bridge/agent-state-event.mjs" turn-end </dev/null >/dev/null 2>&1 &
  pids="$pids $!"
fi
if [ "${2:-}" = "herdr" ]; then
  sh "$(dirname "$0")/aify-herdr-state.sh" idle </dev/null >/dev/null 2>&1 &
  pids="$pids $!"
fi

# ponytail: polls in 0.1 s steps rather than timing out each child, and nothing is killed. It stops
# after 25 steps or once the clock has moved 3 seconds on, whichever comes first, because a loaded
# host stretches every `sleep` and the step count alone let the wait grow past that.
i=0
deadline=$(( $(date +%s) + 3 ))
while [ -n "$pids" ] && [ "$i" -lt 25 ] && [ "$(date +%s)" -lt "$deadline" ]; do
  alive=""
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null && alive="$alive $pid"
  done
  pids="$alive"
  [ -n "$pids" ] || break
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
exit 0
