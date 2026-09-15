# Sourced by the launchers: the shell half of lib/agent-lease.mjs, written once instead of four times.
#
#   aify_lease_take_intent "$@"                                 consumes --aify-start-intent=start|replace;
#                                                               the launcher then runs `set -- "${AIFY_LEASE_ARGS[@]}"`
#   aify_lease_claim <bridge-dir> <agent-id> <runtime> <mode>   returns 75 when refused, 0 otherwise
#   aify_lease_attach <pid> <kind>                              a process this instance started detached
#   aify_lease_release                                          on the launcher's way out
#
# Every function is safe under `set -euo pipefail` and none can fail a launch except by the refusal,
# which is the one outcome that must stop it. An installed bridge older than this file simply has no
# helper, and the claim is skipped.
#
# THE PID IS THE LAUNCHER'S OWN. On Git Bash `$$` is an MSYS pid native Windows cannot see, and node's
# parent there is a short-lived stub rather than this shell, so the Windows pid comes from
# /proc/$$/winpid. `$$` is this shell's pid in a subshell too, so the lookup is safe inside `$(...)`.

# THE INTENT AS AN ARGUMENT, because a Herdr restore TYPES its command into a pane whose shell may be
# PowerShell, cmd or bash, and no environment prefix means the same thing in all three. A restore is
# automatic, so it passes `--aify-start-intent=start` and is refused by a live instance instead of
# replacing it. One token, consumed here, so the runtime never sees it and the recorded argv never
# carries it.
#
# IT ALSO NOTES WHETHER THIS COMMAND NAMES ITS AGENT. Only an agent named here, by `--aify-agent` or
# `--agent-id`, may replace a live instance of it (lib/agent-lease.mjs `startIntent`). An identity taken from
# the environment or recovered from a conversation is a guess about who is meant: on 2026-09-15 one came
# from a pane that had inherited another session's environment, and replaced that session's live agent.
aify_lease_take_intent() {
  AIFY_LEASE_ARGS=()
  AIFY_LEASE_IDENTITY="recovered"
  local _aify_arg
  for _aify_arg in "$@"; do
    case "$_aify_arg" in
      --aify-start-intent=*) AIFY_START_INTENT="${_aify_arg#--aify-start-intent=}" ;;
      --aify-agent|--agent-id|--aify-agent=*|--agent-id=*) AIFY_LEASE_IDENTITY="flag"; AIFY_LEASE_ARGS+=("$_aify_arg") ;;
      *) AIFY_LEASE_ARGS+=("$_aify_arg") ;;
    esac
  done
}

aify_lease_pid() {
  if [ -r "/proc/$1/winpid" ]; then
    cat "/proc/$1/winpid"
  else
    printf '%s' "$1"
  fi
}

aify_lease_claim() {
  # The intent was for THIS start, whichever way this function returns: a shell the agent opens later
  # must not hand it to a launch of its own.
  local _aify_intent="${AIFY_START_INTENT:-}"
  unset AIFY_START_INTENT
  AIFY_LEASE_AGENT=""
  [ -n "${2:-}" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  AIFY_LEASE_HELPER="$1/node_modules/aify-wrapper/bin/aify-agent-lease.mjs"
  [ -f "$AIFY_LEASE_HELPER" ] || return 0
  if command -v cygpath >/dev/null 2>&1; then
    AIFY_LEASE_HELPER="$(cygpath -m "$AIFY_LEASE_HELPER" 2>/dev/null || printf '%s' "$AIFY_LEASE_HELPER")"
  fi
  AIFY_LEASE_PID="$(aify_lease_pid "$$")"
  _aify_lease_status=0
  node "$AIFY_LEASE_HELPER" claim --agent "$2" --pid "$AIFY_LEASE_PID" --runtime "${3:-}" --mode "${4:-}" \
    --identity "${AIFY_LEASE_IDENTITY:-recovered}" ${_aify_intent:+--intent "$_aify_intent"} </dev/null || _aify_lease_status=$?
  [ "$_aify_lease_status" = 75 ] && return 75
  AIFY_LEASE_AGENT="$2"
  export AIFY_AGENT_LEASE="$AIFY_LEASE_PID"
  return 0
}

aify_lease_attach() {
  [ -n "${AIFY_LEASE_AGENT:-}" ] && [ -n "${1:-}" ] || return 0
  node "$AIFY_LEASE_HELPER" attach --agent "$AIFY_LEASE_AGENT" --instance "$AIFY_LEASE_PID" \
    --pid "$(aify_lease_pid "$1")" --kind "${2:-}" </dev/null >/dev/null 2>&1 || true
}

aify_lease_release() {
  [ -n "${AIFY_LEASE_AGENT:-}" ] || return 0
  node "$AIFY_LEASE_HELPER" release --agent "$AIFY_LEASE_AGENT" --pid "$AIFY_LEASE_PID" </dev/null >/dev/null 2>&1 || true
  AIFY_LEASE_AGENT=""
}
