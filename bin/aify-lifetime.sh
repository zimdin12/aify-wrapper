# Sourced by aify-lease.sh. C4 records belong to the waiting launcher, not its runtime.
AIFY_LIFETIME_AGENT="${AIFY_AGENT_ID:-}"
AIFY_RESIDENT_RECORD=""

aify_lifetime_start() {
  local _bridge="$1" _agent="$2" _harness="$3" _mode="$4" _instance="${AIFY_ENV_INSTANCE:-default}"
  # A host-minted lifetime is addressed to the inherited identity, before the launcher exports its own.
  if [ "$_mode" = managed ] && [ -n "$_agent" ] && [ "$_agent" = "$AIFY_LIFETIME_AGENT" ] \
    && [ -n "${AIFY_LIFETIME:-}" ] && [ -n "${AIFY_ENV_INSTANCE:-}" ] && [ -n "${AIFY_ENV_URL:-}" ]; then
    return 0
  fi
  unset AIFY_LIFETIME AIFY_ENV_URL AIFY_ENV_INSTANCE
  [ "$_mode" = resident ] && [ -n "$_agent" ] || return 0
  local _helper="$_bridge/node_modules/aify-wrapper/bin/aify-resident-record.mjs" _root="$HOME/.aify/residents"
  if command -v cygpath >/dev/null 2>&1; then
    _root="$(cygpath -m "$_root")" || return 78
  fi
  local _clock="${EPOCHREALTIME:-}" _pid
  _pid="$(aify_lease_pid "$$")" || return 78
  if ! AIFY_LIFETIME="$(MSYS_NO_PATHCONV=1 node "$_helper" "$_root" "$_agent" "$_instance" "$_harness" "$_pid" "$0" "${_clock/./}" "${AIFY_HERDR_PANE_ID:-${HERDR_PANE_ID:-}}")"; then
    echo "${0##*/}: cannot write the resident lifetime; nothing was started." >&2
    return 78
  fi
  AIFY_RESIDENT_RECORD="$HOME/.aify/residents/$_agent.$AIFY_LIFETIME.json"
  export AIFY_LIFETIME AIFY_ENV_INSTANCE="$_instance"
}

aify_lifetime_release() {
  [ -n "$AIFY_RESIDENT_RECORD" ] || return 0
  rm -f -- "$AIFY_RESIDENT_RECORD" || true
  AIFY_RESIDENT_RECORD=""
}
