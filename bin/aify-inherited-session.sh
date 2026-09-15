# Sourced by every launcher, before anything reads an identity, a mode or a conversation from the environment.
#
#   aify_forget_inherited_session flag|recovered
#       when a marker is set: unsets what a start never inherits, and -- unless the command named its agent
#       (`flag`, from aify_lease_take_intent) -- what names the session too; says which
#
# The shell half of lib/inherited-session.mjs, which says why these names and why the split; a test holds the
# lists equal. A bare launch typed into a shell inside a running session starts anonymous instead of as the
# agent whose session the shell came from -- which, as that agent, replaced its live instance on 2026-09-15.
# A launch a host composed names its agent, so it keeps the mode and role its host gave it.

AIFY_SESSION_MARKERS="AIFY_AGENT_LEASE CLAUDE_CODE_CHILD_SESSION"
AIFY_NEVER_INHERITED_BY_A_START="AIFY_START_INTENT AIFY_SESSION_HANDLE CLAUDE_SESSION_ID CODEX_THREAD_ID HERMES_SESSION_ID HERMES_SESSION PI_SESSION_ID OMP_SESSION_ID AIFY_PI_SESSION_ID"
AIFY_NAMES_THE_SESSION="AIFY_AGENT_ID AIFY_COMMS_AGENT_ID AIFY_AGENT_ROLE AIFY_COMMS_AGENT_ROLE AIFY_AGENT_CWD AIFY_SESSION_MODE AIFY_TERMINAL_ID AIFY_MANAGED_VIA_WRAPPER AIFY_MANAGED_MODEL AIFY_MANAGED_EFFORT AIFY_HERMES_FRESH_CONTEXT"

aify_forget_inherited_session() {
  local _aify_name _aify_marker="" _aify_dropped="" _aify_names="$AIFY_NEVER_INHERITED_BY_A_START"
  for _aify_name in $AIFY_SESSION_MARKERS; do
    if [ -n "${!_aify_name:-}" ]; then
      _aify_marker="$_aify_name"
      break
    fi
  done
  [ -n "$_aify_marker" ] || return 0
  # Anything but `flag` is a command that did not name its agent: the careful reading of a missing answer.
  [ "${1:-}" = "flag" ] || _aify_names="$AIFY_NAMES_THE_SESSION $_aify_names"
  for _aify_name in $_aify_names; do
    if [ -n "${!_aify_name+set}" ]; then
      _aify_dropped="$_aify_dropped $_aify_name"
      unset "$_aify_name"
    fi
  done
  if [ -n "$_aify_dropped" ]; then
    if [ "${1:-}" = "flag" ]; then
      printf '[aify] this shell belongs to a running agent session (%s is set), so this start inherits none of its conversation or start intent; ignored:%s.\n' "$_aify_marker" "$_aify_dropped" >&2
    else
      printf '[aify] this shell belongs to a running agent session (%s is set), so it names no agent; ignored:%s. Pass --aify-agent to start one.\n' "$_aify_marker" "$_aify_dropped" >&2
    fi
  fi
  return 0
}
