# An agent's definition, read for its launcher by bin/aify-definition.mjs. Sourced by claude-, codex- and hermes-aify,
# which set AIFY_WRAPPER_DIR_FWD, AIFY_IGNORE_DEFINITION and HARNESS_EXIT_CONFIG first; `${0##*/}` names the launcher.
#
# ~/.aify/agent-definitions/<id>.json, written by aify-env, gives this launcher DEFAULTS for role,
# model and effort: below a flag and the environment, above the built-in default. aify-wrapper's
# `aify-definition` helper reads it, never writes it, and validates it as aify-env does. Missing is
# today's behaviour, and only a missing file is: an invalid file, one defining another harness, or a
# launcher that cannot run the reader refuses the launch with 78 unless --aify-ignore-definition,
# because starting without the definition the operator wrote would look like honouring it. A managed
# launch takes only its instructions from the file: its payload carries the rest, which the host checked. Read for
# the RESOLVED id, after a resume handle has named the agent, so a resumed agent gets the same
# defaults and the same refusal as one named by a flag.

# THE DEFAULTS, as the AIFY_DEF_* assignments: `aify_read_definition <id> <harness>`.
# AN INSTALL WITHOUT THE READER cannot tell a missing file from an invalid one, so it refuses as an invalid file does:
# not being able to look is not the same as finding nothing (review of P6, R2); the reader ships beside this file, and
# the launcher's fallback covers a wrapper without either. A MANAGED LAUNCH takes its defaults from the host, which
# already checked them. Claude's reads only its instructions, after the claim (below). Codex and hermes cannot carry
# instructions yet, so a definition with them refuses even then. A managed launch whose definition the reader refuses
# says so and starts.
aify_read_definition() {
  local _id="$1" _harness="$2" _out _reader="$AIFY_WRAPPER_DIR_FWD/bin/aify-definition.mjs" _managed=""
  if [ -z "$_id" ] || [ "$AIFY_IGNORE_DEFINITION" = true ]; then return 0; fi
  if [ "${AIFY_MANAGED_VIA_WRAPPER:-}" = "1" ]; then
    [ "$_harness" != claude ] || return 0
    _managed=--managed
  fi
  if [ ! -f "$_reader" ]; then
    echo "[${0##*/}] no definition reader at $_reader, so the definition of '$_id' cannot be checked." >&2
  fi
  if [ ! -f "$_reader" ] || ! _out="$(node "$_reader" "$_id" "$_harness" $_managed)"; then
    echo "[${0##*/}] the definition of '$_id' cannot be used (above), so nothing was started." >&2
    echo "              Fix the file or the install, or start with --aify-ignore-definition to launch without it." >&2
    exit "$HARNESS_EXIT_CONFIG"
  fi
  eval "$_out"
}

# CLAUDE'S INSTRUCTIONS, as AIFY_DEF_INSTRUCTIONS_FILE: `aify_place_instructions <id>`, called only once the lease has
# admitted the start. The file is the agent's one, so a second launch the lease refuses must not rewrite the running
# session's (the review of f177604 found mcp.json doing so). A managed launch reads the instructions here and nothing
# else, and only from the revision its host admitted: a file at another one, or unreadable, refuses the start (78); a
# host that binds none starts it without them and says so (lib/agent-definition-defaults.mjs managedBinding).
aify_place_instructions() {
  local _id="$1" _out _reader="$AIFY_WRAPPER_DIR_FWD/bin/aify-definition.mjs" _managed=""
  if [ -z "$_id" ] || [ "$AIFY_IGNORE_DEFINITION" = true ]; then return 0; fi
  [ "${AIFY_MANAGED_VIA_WRAPPER:-}" = "1" ] && _managed=--managed
  if [ -z "$_managed" ] && [ -z "$AIFY_DEF_FILE" ]; then return 0; fi
  if ! _out="$(node "$_reader" "$_id" claude --write-instructions $_managed)"; then
    echo "[${0##*/}] the instructions of '$_id' cannot be handed to the runtime (above), so nothing was started." >&2
    exit "$HARNESS_EXIT_CONFIG"
  fi
  eval "$_out"
  # Appended to Claude's own system prompt and rebuilt on a resume, not the prompt recorded when the conversation began
  # (--system-prompt-snapshot off; measured on 2.1.312, 2026-10-28).
  [ -z "${AIFY_DEF_INSTRUCTIONS_FILE:-}" ] || CLAUDE_INSTRUCTION_FLAGS=(--append-system-prompt-file "$AIFY_DEF_INSTRUCTIONS_FILE" --system-prompt-snapshot off)
}
