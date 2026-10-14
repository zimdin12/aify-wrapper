# Sourced by aify-lease.sh. C4 records belong to the waiting launcher, not its runtime.
#
#   aify_lifetime_start <agent-id> <harness> <mode>   the record writer is this file's sibling
AIFY_LIFETIME_BIN="${BASH_SOURCE[0]%/*}"
AIFY_LIFETIME_AGENT="${AIFY_AGENT_ID:-}"
AIFY_RESIDENT_RECORD=""

# The aify home, resolved as aify-env resolves it: Node's os.homedir(), which reads USERPROFILE on Windows and HOME
# elsewhere. Git Bash's HOME can differ from USERPROFILE (a HOME set in the Windows environment), and a record written
# under another home is one the residents role of this home never sees (B1 contract item 1). `cygpath -m` gives the
# drive-letter form aify-env's homedir() yields.
aify_lifetime_home() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "${USERPROFILE:-$HOME}/.aify"
  else
    printf '%s\n' "$HOME/.aify"
  fi
}

aify_lifetime_start() {
  local _agent="$1" _harness="$2" _mode="$3"
  # A host-minted lifetime is addressed to the inherited identity, before the launcher exports its own.
  if [ "$_mode" = managed ] && [ -n "$_agent" ] && [ "$_agent" = "$AIFY_LIFETIME_AGENT" ] \
    && [ -n "${AIFY_LIFETIME:-}" ] && [ -n "${AIFY_ENV_INSTANCE:-}" ] && [ -n "${AIFY_ENV_URL:-}" ]; then
    return 0
  fi
  unset AIFY_LIFETIME AIFY_ENV_URL AIFY_ENV_INSTANCE
  [ "$_mode" = resident ] && [ -n "$_agent" ] || return 0
  # A resident belongs to its home's residents role, whichever aify-env holds it (B1): its record and its hooks carry
  # the role's name, never an inherited instance, so a pane opened by a dedicated Herdr does not bind it to that Herdr.
  local _helper="$AIFY_LIFETIME_BIN/aify-resident-record.mjs" _root
  _root="$(aify_lifetime_home)/residents" || return 78
  if command -v cygpath >/dev/null 2>&1; then
    _helper="$(cygpath -m "$_helper")" || return 78
  fi
  local _clock="${EPOCHREALTIME:-}" _pid
  _pid="$(aify_lease_pid "$$")" || return 78
  if ! AIFY_LIFETIME="$(MSYS_NO_PATHCONV=1 node "$_helper" "$_root" "$_agent" residents "$_harness" "$_pid" "$0" "${_clock/./}" "${AIFY_HERDR_PANE_ID:-${HERDR_PANE_ID:-}}")"; then
    echo "${0##*/}: cannot write the resident lifetime; nothing was started." >&2
    return 78
  fi
  AIFY_RESIDENT_RECORD="$_root/$_agent.$AIFY_LIFETIME.json"
  export AIFY_LIFETIME AIFY_ENV_INSTANCE=residents
}

aify_lifetime_release() {
  [ -n "$AIFY_RESIDENT_RECORD" ] || return 0
  rm -f -- "$AIFY_RESIDENT_RECORD" || true
  AIFY_RESIDENT_RECORD=""
}
