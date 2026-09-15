# Sourced FIRST by every launcher: a shell that belongs to a running agent session names no agent.
#
#   aify_forget_inherited_session    when a marker is set, unsets every carrier and says which
#
# The shell half of lib/inherited-session.mjs, which says why these names and no others; a test holds the
# two lists equal. It runs before a launcher reads an identity, a mode, a start intent or a conversation to
# resume, so a bare launch typed into such a shell starts anonymous instead of as the agent whose session
# the shell came from -- which, as that agent, replaced its live instance on 2026-09-15.
#
# `--aify-agent` still names an agent from any shell: only what the ENVIRONMENT said is dropped.

AIFY_SESSION_MARKERS="AIFY_AGENT_LEASE CLAUDE_CODE_CHILD_SESSION"
AIFY_SESSION_CARRIERS="AIFY_AGENT_ID AIFY_COMMS_AGENT_ID AIFY_AGENT_ROLE AIFY_COMMS_AGENT_ROLE AIFY_AGENT_CWD AIFY_SESSION_MODE AIFY_SESSION_HANDLE AIFY_START_INTENT AIFY_TERMINAL_ID AIFY_MANAGED_VIA_WRAPPER AIFY_MANAGED_MODEL AIFY_MANAGED_EFFORT AIFY_HERMES_FRESH_CONTEXT CLAUDE_SESSION_ID CODEX_THREAD_ID HERMES_SESSION_ID HERMES_SESSION PI_SESSION_ID OMP_SESSION_ID AIFY_PI_SESSION_ID"

aify_forget_inherited_session() {
  local _aify_name _aify_marker="" _aify_dropped=""
  for _aify_name in $AIFY_SESSION_MARKERS; do
    if [ -n "${!_aify_name:-}" ]; then
      _aify_marker="$_aify_name"
      break
    fi
  done
  [ -n "$_aify_marker" ] || return 0
  for _aify_name in $AIFY_SESSION_CARRIERS; do
    if [ -n "${!_aify_name+set}" ]; then
      _aify_dropped="$_aify_dropped $_aify_name"
      unset "$_aify_name"
    fi
  done
  if [ -n "$_aify_dropped" ]; then
    printf '[aify] this shell belongs to a running agent session (%s is set), so it names no agent; ignored:%s. Pass --aify-agent to start one.\n' "$_aify_marker" "$_aify_dropped" >&2
  fi
  return 0
}
