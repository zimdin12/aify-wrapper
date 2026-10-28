# Node >= 22 for hermes' TUI, sourced by hermes-aify: `aify_ensure_node_ge_22` returns 0 whatever it finds.
#
# Node >=22 guarantee. The Hermes Ink TUI's gateway client attaches over a
# WebSocket using the global `WebSocket` constructor, which only exists in
# Node 22+. When the aify-comms bridge spawns this wrapper as a managed
# worker it runs under a non-interactive login shell (e.g. `zsh -lc`), which
# does NOT source .zshrc — so an nvm default of Node 22 is invisible and PATH
# falls back to a system Node 20. The TUI then dies with "gateway exited",
# but the SAME wrapper works when launched from an interactive terminal. Pin
# a Node >=22 here so managed and interactive launches behave identically.
# Opt out with AIFY_HERMES_SKIP_NODE_CHECK=1.
aify_node_major_of() {
  local nbin="$1" ver
  ver="$("$nbin" -v 2>/dev/null)" || return 1
  ver="${ver#v}"
  printf '%s' "${ver%%.*}"
}

aify_ensure_node_ge_22() {
  [ "${AIFY_HERMES_SKIP_NODE_CHECK:-0}" = "1" ] && return 0
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(aify_node_major_of node || true)"
  fi
  if [ -n "$current_major" ] && [ "$current_major" -ge 22 ] 2>/dev/null; then
    return 0
  fi
  # 1. Honor an explicitly configured HERMES_NODE if it is >=22.
  if [ -n "${HERMES_NODE:-}" ] && [ -x "${HERMES_NODE:-}" ]; then
    local hm
    hm="$(aify_node_major_of "$HERMES_NODE" || true)"
    if [ -n "$hm" ] && [ "$hm" -ge 22 ] 2>/dev/null; then
      PATH="$(dirname "$HERMES_NODE"):$PATH"
      export PATH HERMES_NODE
      return 0
    fi
  fi
  # 2. Scan nvm-installed versions for the highest major >=22 (parse the
  #    version dir name so we don't exec every candidate during the scan).
  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  local best_bin="" best_major=0 candidate vdir cand_major
  if [ -d "$nvm_root/versions/node" ]; then
    for candidate in "$nvm_root"/versions/node/v*/bin/node; do
      [ -x "$candidate" ] || continue
      vdir="$(basename "$(dirname "$(dirname "$candidate")")")"
      cand_major="${vdir#v}"; cand_major="${cand_major%%.*}"
      case "$cand_major" in ''|*[!0-9]*) continue ;; esac
      if [ "$cand_major" -ge 22 ] && [ "$cand_major" -gt "$best_major" ]; then
        best_major="$cand_major"
        best_bin="$candidate"
      fi
    done
  fi
  if [ -n "$best_bin" ]; then
    PATH="$(dirname "$best_bin"):$PATH"
    export PATH
    export HERMES_NODE="$best_bin"
    return 0
  fi
  # 3. Nothing suitable found. Warn; the TUI may fail with "gateway exited".
  echo "[hermes-aify] WARNING: Node >=22 not found (current node: ${current_major:-none})." >&2
  echo "[hermes-aify]   The Hermes TUI gateway client needs Node 22+ (global WebSocket)." >&2
  echo "[hermes-aify]   Install via nvm (nvm install 22) or set HERMES_NODE to a Node>=22 binary." >&2
  return 0
}
