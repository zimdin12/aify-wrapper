# Sourced by claude-aify: model scan hooks, initialized only by the actual lease-owning lifetime.
# No native settings composition: forwarded --settings keeps its own semantics in the Node producer.
aify_model_selection_hooks() {
  unset AIFY_MODEL_SELECTION
  local AIFY_WRAPPER_DIR_FWD="$2" hook
  [ -n "$1" ] && [ -f "$AIFY_WRAPPER_DIR_FWD/bin/aify-model-selection.mjs" ] || return 0
  hook="$(printf '{ "type": "command", "command": "node \\"%s/bin/aify-model-selection.mjs\\" hook", "timeout": 5 }' "$AIFY_WRAPPER_DIR_FWD")"
  AIFY_MODEL_HOOK=", $hook"
  AIFY_MODEL_STOP=", \"Stop\": [ { \"hooks\": [ $hook ] } ]"
  AIFY_MODEL_EVENTS=", \"PostModelSwitch\": [ { \"hooks\": [ $hook ] } ], \"SessionEnd\": [ { \"hooks\": [ $hook ] } ]"
}

aify_model_selection_start() {
  [ -n "${AIFY_LEASE_AGENT:-}" ] && [ "$1" = "$AIFY_LEASE_AGENT" ] && [ -n "${AIFY_LIFETIME:-}" ] || return 0
  [ -f "$AIFY_WRAPPER_DIR_FWD/bin/aify-model-selection.mjs" ] || return 0
  local agent="$1" resume="$2" settings="$3"
  shift 3
  AIFY_MODEL_SELECTION="$(node "$AIFY_WRAPPER_DIR_FWD/bin/aify-model-selection.mjs" init "$agent" "$resume" "$settings" -- "$@" </dev/null)" || AIFY_MODEL_SELECTION=""
  export AIFY_MODEL_SELECTION
}

aify_model_selection_finish() {
  [ -n "${AIFY_MODEL_SELECTION:-}" ] && [ "$AIFY_MODEL_SELECTION" = "${AIFY_LIFETIME:-}" ] || return 0
  node "$AIFY_WRAPPER_DIR_FWD/bin/aify-model-selection.mjs" finish </dev/null >/dev/null || true
}
