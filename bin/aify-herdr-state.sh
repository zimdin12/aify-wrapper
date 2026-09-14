#!/bin/sh
# Tell Herdr what the agent in an aify pane is doing: aify-herdr-state.sh working|idle|blocked
#
# WHY THIS EXISTS. The pane claim reports the agent under `herdr:aify`, and Herdr shows a claimed
# pane's state from the claim and not from its own screen detection (v0.9.0,
# `recompute_effective_state`). The claim reported `idle` once, so every aify pane read idle for
# its whole life. The launcher runs this from the agent's own hooks so the claim's state follows
# the agent.
#
# WHICH PANE. A pane the launcher claimed is HERDR_PANE_ID. A managed worker runs under aify-env,
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
  pane="${HERDR_PANE_ID:-}"
fi
case "$pane" in
  w[0-9]*:p[0-9]*) ;;
  *) exit 0 ;;
esac

# The source must be the claim's, or Herdr refuses the report as coming from another owner.
"${HERDR_BIN_PATH:-herdr}" pane report-agent "$pane" --source herdr:aify --agent "$AIFY_HERDR_AGENT" --state "$state" >/dev/null 2>&1 || true
exit 0
