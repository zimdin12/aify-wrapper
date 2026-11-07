# Sourced launcher common API v1. Definitions only: sourcing starts no process and changes no exported value.
#
#   aify_extra_env_apply <raw-lines>                       exports accepted pairs; preserves Bash export/errexit behavior
#   aify_shared_require_host                             returns 69 when aify-env is absent, otherwise 0
#   aify_shared_drop_inferred_mode                       unsets only an inferred AIFY_SESSION_MODE; always succeeds
#   aify_shared_handoff <service> <launcher> <label> [argv...]  execs the existing host command with exact argument boundaries
#
# Rendered launchers call the live package's helpers. Keep these v1 names/positions compatible or add v2 names;
# changing the helper in place must not require every installed launcher to have been re-rendered first.
# Runtime-specific cleanup/traps and their order stay at callers. Handoff gets its launcher explicitly, not from $0.
# Do not local/declare the pair or any exported variable: that would lose exports at function return.

aify_extra_env_apply() {
  if [ -n "${1:-}" ]; then
    while IFS= read -r _pair; do
      case "$_pair" in
        ""|"#"*) continue ;;
        *=*)
          # Builtin glob, not tr: an earlier accepted PATH= must not disable the protected-prefix filter.
          case "${_pair%%=*}" in
            [Aa][Ii][Ff][Yy]_*|[Hh][Aa][Rr][Nn][Ee][Ss][Ss]_*) echo "${0##*/}: HARNESS_EXTRA_ENV may not set ${_pair%%=*}, which aify owns; skipped" >&2 ;;
            *) export "${_pair%%=*}=${_pair#*=}" ;;
          esac ;;
      esac
    done <<HARNESS_ENV_EOF
$1
HARNESS_ENV_EOF
  fi
}

aify_shared_require_host() {
  if ! command -v aify-env >/dev/null 2>&1; then
    echo "${0##*/}: --shared needs aify-env on PATH; it is the tier that would own the session." >&2
    echo "  Install it, or run without --shared to start in this terminal as usual." >&2
    return 69
  fi
  return 0
}

aify_shared_drop_inferred_mode() {
  # A false no-op predicate must not become a failing function call under the caller's set -e.
  if [ "${AIFY_SESSION_MODE_INFERRED:-0}" = 1 ]; then unset AIFY_SESSION_MODE; fi
  return 0
}

aify_shared_handoff() {
  exec aify-env run --service "$1" --launcher "$2" --label "$3" -- "${@:4}"
}
