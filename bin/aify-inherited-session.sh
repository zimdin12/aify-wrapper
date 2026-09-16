# Sourced by every launcher, before anything reads an identity, a mode or a conversation from the environment.
#
#   aify_forget_inherited_session [agent the command names]
#       when a marker is set: unsets what a start never inherits, and -- unless the command names the agent
#       whose session this environment IS -- what names the session too; says which
#
# The shell half of lib/inherited-session.mjs, which says why these names and why the split; a test holds the
# lists equal. A bare launch typed into a shell inside a running session starts anonymous instead of as the
# agent whose session the shell came from -- which, as that agent, replaced its live instance on 2026-09-15.
# A launch a HOST composed names that host's own agent, so it keeps the mode, role and terminal its host gave
# it; one agent's shell starting a DIFFERENT agent keeps none of them (external review, 2026-09-16), or that
# agent would report itself running in the first one's terminal.

AIFY_SESSION_MARKERS="AIFY_AGENT_LEASE CLAUDE_CODE_CHILD_SESSION"
AIFY_NEVER_INHERITED_BY_A_START="AIFY_START_INTENT AIFY_SESSION_HANDLE CLAUDE_SESSION_ID CODEX_THREAD_ID HERMES_SESSION_ID HERMES_SESSION PI_SESSION_ID OMP_SESSION_ID AIFY_PI_SESSION_ID"
AIFY_NAMES_THE_SESSION="AIFY_AGENT_ID AIFY_COMMS_AGENT_ID AIFY_AGENT_ROLE AIFY_COMMS_AGENT_ROLE AIFY_AGENT_CWD AIFY_SESSION_MODE AIFY_TERMINAL_ID AIFY_MANAGED_VIA_WRAPPER AIFY_MANAGED_MODEL AIFY_MANAGED_EFFORT AIFY_HERMES_FRESH_CONTEXT"

aify_forget_inherited_session() {
  local _aify_name _aify_marker="" _aify_dropped="" _aify_named="${1:-}" _aify_session_agent="" _aify_keep=""
  local _aify_names="$AIFY_NEVER_INHERITED_BY_A_START"
  for _aify_name in $AIFY_SESSION_MARKERS; do
    if [ -n "${!_aify_name:-}" ]; then
      _aify_marker="$_aify_name"
      break
    fi
  done
  [ -n "$_aify_marker" ] || return 0
  # REMEMBERED FOR THE CLAIM, which cannot ask the environment again: claude-aify unsets
  # CLAUDE_CODE_CHILD_SESSION before it claims, so Claude Code keeps saving transcripts, and the marker is
  # gone by then. A start made from inside a session replaces nothing it was not told to (bin/aify-lease.sh,
  # lib/agent-lease.mjs `startIntent`). Not exported: it is this launcher's own note, not the runtime's.
  AIFY_LEASE_INSIDE_SESSION=1
  _aify_session_agent="${AIFY_AGENT_ID:-${AIFY_COMMS_AGENT_ID:-}}"
  # The host's values travel only to a launch of the agent this environment belongs to. An environment naming
  # a DIFFERENT agent is another agent's session, and none of it is this start's. One naming NO agent is a host
  # that composed this launch and nothing else -- dropping its mode there makes a managed worker read as a
  # person at a terminal, which turns its start into a replace (measured 2026-09-16, two launcher tests).
  if [ -n "$_aify_named" ] && { [ -z "$_aify_session_agent" ] || [ "$_aify_named" = "$_aify_session_agent" ]; }; then
    _aify_keep=1
  else
    _aify_names="$AIFY_NAMES_THE_SESSION $_aify_names"
  fi
  for _aify_name in $_aify_names; do
    if [ -n "${!_aify_name+set}" ]; then
      _aify_dropped="$_aify_dropped $_aify_name"
      unset "$_aify_name"
    fi
  done
  if [ -n "$_aify_dropped" ]; then
    if [ -n "$_aify_keep" ]; then
      printf '[aify] this shell belongs to a running agent session (%s is set), so this start inherits none of its conversation or start intent; ignored:%s.\n' "$_aify_marker" "$_aify_dropped" >&2
    elif [ -n "$_aify_named" ]; then
      printf '[aify] this shell belongs to %s (%s is set) and this start names %s, so it inherits nothing of that session; ignored:%s.\n' "${_aify_session_agent:-a running agent session}" "$_aify_marker" "$_aify_named" "$_aify_dropped" >&2
    else
      printf '[aify] this shell belongs to a running agent session (%s is set), so it names no agent; ignored:%s. Pass --aify-agent to start one.\n' "$_aify_marker" "$_aify_dropped" >&2
    fi
  fi
  return 0
}
