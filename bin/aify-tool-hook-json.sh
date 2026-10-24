# Sourced hook JSON formatter. Inputs: activity flag, native wrapper root, outcome.
_aify_tool_hook() {
  local AIFY_WRAPPER_DIR_FWD="$2"
  if [ "$1" = 1 ]; then
    printf '{ "type": "command", "command": "node \\"%s/bin/aify-tool-event.mjs\\" %s", "timeout": 5, "async": true }' "$AIFY_WRAPPER_DIR_FWD" "$3"
  else
    printf '{ "type": "command", "command": "sh \\"%s/bin/aify-herdr-state.sh\\" working", "timeout": 5, "async": true }' "$AIFY_WRAPPER_DIR_FWD"
  fi
}
