#!/bin/bash
# Install a harness wrapper onto this machine.
#
#   install.sh --client <claude|codex|hermes|pi> --endpoint <url> [options]
#
# A wrapper resolves the runtime CLI, exports an identity environment, points the runtime at an MCP
# bridge, and execs the runtime with argv forwarded. It speaks the harness contract: six HARNESS_*
# inputs read at launch, `--check` to validate without starting anything, and the exit codes below.
# See README.md.
#
# Options:
#   --client <name>        which launcher to install (required)
#   --endpoint <url>       coordinating service URL baked in as the fallback (required)
#   --dest <dir>           where to install (default: ~/.local/bin)
#   --bridge-dir <dir>     directory holding the MCP bridge (default: ~/.aify-comms/mcp/stdio)
#   --native-base <dir>    the bridge's install root (default: ~/.aify-comms)
#   --host-repo <dir>      host checkout, for hooks that must run from source
#   --set KEY=VALUE        extra placeholder, repeatable (hermes needs three; see README)
#   --render-only <dir>    write the launcher into <dir> and exit, touching nothing else
#
# Exit codes match the contract the wrappers themselves use: 78 configuration invalid, 127 a required
# command is missing.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXIT_CONFIG=78
EXIT_NO_RUNTIME=127

CLIENT=""
ENDPOINT=""
DEST="$HOME/.local/bin"
NATIVE_BASE="$HOME/.aify-comms"
BRIDGE_DIR=""
HOST_REPO=""
RENDER_ONLY=""
EXTRAS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --client) CLIENT="${2:-}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    --bridge-dir) BRIDGE_DIR="${2:-}"; shift 2 ;;
    --native-base) NATIVE_BASE="${2:-}"; shift 2 ;;
    --host-repo) HOST_REPO="${2:-}"; shift 2 ;;
    --set) EXTRAS+=("${2:-}"); shift 2 ;;
    --render-only) RENDER_ONLY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option '$1'" >&2; exit "$EXIT_CONFIG" ;;
  esac
done

case "$CLIENT" in
  claude|codex|hermes|pi) ;;
  "") echo "install.sh: --client is required (claude|codex|hermes|pi)" >&2; exit "$EXIT_CONFIG" ;;
  *) echo "install.sh: unknown client '$CLIENT'" >&2; exit "$EXIT_CONFIG" ;;
esac

if [ -z "$ENDPOINT" ]; then
  echo "install.sh: --endpoint is required. A wrapper will not guess where its service lives." >&2
  exit "$EXIT_CONFIG"
fi

[ -n "$BRIDGE_DIR" ] || BRIDGE_DIR="$NATIVE_BASE/mcp/stdio"
[ -n "$HOST_REPO" ] || HOST_REPO="$NATIVE_BASE"

VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"

# Hermes needs three values only its host can compute: a plugin path converted for a native-Windows
# runtime, a bridge dir in a form Git-Bash node can open, and a prebuilt TUI bundle that is baked only
# when it exists. Defaulting them to empty keeps `--set` optional for a host that has none of them;
# hermes treats an empty TUI dir as "locate or build it as before", which never breaks.
if [ "$CLIENT" = "hermes" ]; then
  _have() { printf '%s\n' "${EXTRAS[@]:-}" | grep -q "^$1="; }
  _have HERMES_PLUGIN_PATH || EXTRAS+=("HERMES_PLUGIN_PATH=$HOST_REPO/integrations/hermes-aify-plugin")
  _have HERMES_STDIO_DIR   || EXTRAS+=("HERMES_STDIO_DIR=$BRIDGE_DIR")
  _have HERMES_TUI_DIR     || EXTRAS+=("HERMES_TUI_DIR=")
fi

names_for_client() {
  case "$1" in
    claude) echo "claude-aify" ;;
    codex)  echo "codex-aify" ;;
    hermes) echo "hermes-aify" ;;
    pi)     echo "pi-aify omp-aify" ;;
  esac
}

out_dir="${RENDER_ONLY:-$DEST}"
primary=""
for name in $(names_for_client "$CLIENT"); do
  target="$out_dir/$name"
  if [ -z "$primary" ]; then
    bash "$HERE/render.sh" "$CLIENT-aify.sh.in" "$target" \
      "ENDPOINT=$ENDPOINT" \
      "WRAPPER_VERSION=$VERSION" \
      "BRIDGE_DIR=$BRIDGE_DIR" \
      "NATIVE_BASE=$NATIVE_BASE" \
      "SCRIPT_DIR=$HOST_REPO" \
      ${EXTRAS[@]+"${EXTRAS[@]}"}
    primary="$target"
  else
    # pi ships an alias; the launcher reads its own name, so a copy is the whole difference.
    cp "$primary" "$target"
    chmod +x "$target"
  fi
  echo "wrote $target"
done

if [ -n "$RENDER_ONLY" ]; then
  exit 0
fi

# A launcher not on PATH is a launcher nobody runs. Say so rather than leaving it to be discovered.
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "note: $DEST is not on PATH; add it or the launcher cannot be invoked by name." >&2 ;;
esac

echo
echo "Installed $CLIENT wrapper $VERSION. Verify without starting anything:"
echo "  $(names_for_client "$CLIENT" | awk '{print $1}') --check"
