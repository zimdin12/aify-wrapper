# Shared literal-input boundaries. Sourced in-process; never evaluates input or prints its value.
_aify_input_has_control() {
  local LC_ALL=C
  case "$1" in *[[:cntrl:]]*|*$'\302'[$'\200'-$'\237']*) return 0 ;; esac
  return 1
}
_aify_input_refused() {
  printf '%s: %s contains unsupported %s; input refused.\n' "${0##*/}" "$1" "$2" >&2
  return 78
}
aify_json_scalar_safe() {
  [ "$#" -eq 2 ] || return 78
  local name="$1" value="$2"
  if _aify_input_has_control "$value"; then _aify_input_refused "$name" 'control characters'; return 78; fi
  case "$value" in *\"*|*\\*) _aify_input_refused "$name" 'JSON-scalar characters'; return 78 ;; esac
  return 0
}
