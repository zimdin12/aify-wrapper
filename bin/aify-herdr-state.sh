#!/bin/sh
# Tell Herdr what the agent in an aify pane is doing: aify-herdr-state.sh working|idle|blocked
#
# WHY THIS EXISTS. The pane claim reports the agent under `herdr:aify`, and Herdr shows a claimed
# pane's state from the claim and not from its own screen detection (v0.9.0,
# `recompute_effective_state`). The claim reported `idle` once, so every aify pane read idle for
# its whole life. The launcher runs this from the agent's own hooks so the claim's state follows
# the agent.
#
# WHICH PANE. A pane the launcher claimed is AIFY_HERDR_PANE_ID -- the launcher's own copy of
# HERDR_PANE_ID, kept because the launcher REMOVES HERDR_PANE_ID from a claimed agent's environment.
# That variable is the one Herdr's own agent integration needs in order to report the pane under
# Herdr's source, which would undo the claim and hand the pane back to Herdr's native resume; aify's
# reports go on using the private copy. HERDR_PANE_ID stays as the fallback, so a launcher written
# before that change still reports through an updated bridge. A managed worker runs under aify-env,
# not in the pane that shows it, so aify-env names that pane in the file AIFY_HERDR_PANE_FILE points
# at, once the pane exists. Until then there is nothing to report to.
#
# NEVER FAILS AND NEVER PRINTS. It runs inside the agent's hooks, where output or a non-zero exit
# would reach the agent.

cat >/dev/null 2>&1 || true

state="${1:-}"
case "$state" in
  working|idle|blocked) ;;
  *) exit 0 ;;
esac
[ -n "${AIFY_HERDR_AGENT:-}" ] || exit 0

pane=""
if [ -n "${AIFY_HERDR_PANE_FILE:-}" ]; then
  [ -r "$AIFY_HERDR_PANE_FILE" ] && pane="$(head -n 1 "$AIFY_HERDR_PANE_FILE" 2>/dev/null || true)"
else
  pane="${AIFY_HERDR_PANE_ID:-${HERDR_PANE_ID:-}}"
fi
case "$pane" in
  w[0-9]*:p[0-9]*) ;;
  *) exit 0 ;;
esac

# AN UNCHANGED STATE IS NOT SENT AGAIN. PostToolUse fires on every tool call, so each report added a
# Herdr round trip to every tool call. Only a change reaches Herdr. The last report is kept per pane and
# tagged with the launcher that made it (AIFY_HERDR_LAUNCH), so a later launch in a reused pane id starts
# clean. It is written only after Herdr accepted the report, so a failed one is retried by the next hook.
#
# IN THE ORDER THE HOOKS FIRED. The hooks run in the background so the agent never waits on them, and
# two can finish out of order: an idle that lands before its turn's last working would leave the pane
# reading working. Each report carries when it fired (AIFY_HOOK_FIRED_AT from the caller, else this
# shell's EPOCHREALTIME; a shell with neither is unordered): one older than the last report is dropped,
# and one that finishes after a later report re-sends that later state.
fired="${AIFY_HOOK_FIRED_AT:-${EPOCHREALTIME:-}}"
case "$fired" in *[.,]*) fired="${fired%%[.,]*}${fired#*[.,]}" ;; esac
case "$fired" in ''|*[!0-9]*) fired=0 ;; esac
report() {
  "${HERDR_BIN_PATH:-herdr}" pane report-agent "$pane" --source herdr:aify --agent "$AIFY_HERDR_AGENT" --state "$1" >/dev/null 2>&1
}
cache=""
last_state="" last_at=0
if [ -n "${AIFY_HERDR_LAUNCH:-}" ]; then
  cache="${TMPDIR:-/tmp}/aify-herdr-$(printf '%s' "$pane" | tr ':' '-').state"
  read_last() {
    last_state="" last_at=0
    set -- $(cat "$cache" 2>/dev/null || true)
    [ "${1:-}" = "$AIFY_HERDR_LAUNCH" ] || return 0
    last_state="${2:-}"
    case "${3:-0}" in ''|*[!0-9]*) last_at=0 ;; *) last_at="$3" ;; esac
  }
  read_last
  [ "$last_state" = "$state" ] && exit 0
  [ "$fired" -gt 0 ] && [ "$last_at" -gt "$fired" ] && exit 0
fi

# The source must be the claim's, or Herdr refuses the report as coming from another owner.
if report "$state" && [ -n "$cache" ]; then
  read_last
  if [ "$fired" -gt 0 ] && [ "$last_at" -gt "$fired" ]; then
    report "$last_state" || true
  else
    printf '%s' "$AIFY_HERDR_LAUNCH $state $fired" > "$cache" 2>/dev/null || true
  fi
fi
exit 0
