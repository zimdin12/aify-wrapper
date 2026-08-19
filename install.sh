#!/bin/bash
# Install harness wrappers onto this machine.
#
#   install.sh --all --endpoint <url> [options]
#   install.sh --client <claude|codex|hermes|pi> --endpoint <url> [options]
#
# A wrapper resolves the runtime CLI, exports an identity environment, points the runtime at an MCP
# bridge, and execs the runtime with argv forwarded. It speaks the harness contract: six HARNESS_*
# inputs read at launch, `--check` to validate without starting anything, and the exit codes below.
# See README.md.
#
# Options:
#   --all                  install a launcher for every harness runtime found on PATH
#   --client <name>        install one launcher (mutually exclusive with --all)
#   --endpoint <url>       coordinating service URL baked in as the fallback (required)
#   --dest <dir>           where to install (default: ~/.local/bin)
#   --bridge-dir <dir>     directory holding the MCP bridge (default: ~/.aify-comms/mcp/stdio)
#   --native-base <dir>    the bridge's install root (default: ~/.aify-comms)
#   --host-repo <dir>      host checkout, for hooks that must run from source
#   --set KEY=VALUE        extra placeholder, repeatable (hermes needs three; see README)
#   --registry <path>      service registry to build against (default: ~/.aify/services.json)
#   --render-only <dir>    write the launchers into <dir> and exit, touching nothing else
#
# Exit codes match the contract the wrappers themselves use: 78 configuration invalid, 127 a required
# command is missing.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXIT_CONFIG=78
EXIT_NO_RUNTIME=127

ALL=0
CLIENT=""
ENDPOINT=""
DEST="$HOME/.local/bin"
NATIVE_BASE="$HOME/.aify-comms"
BRIDGE_DIR=""
HOST_REPO=""
RENDER_ONLY=""
REGISTRY=""
EXTRAS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --client) CLIENT="${2:-}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    --bridge-dir) BRIDGE_DIR="${2:-}"; shift 2 ;;
    --native-base) NATIVE_BASE="${2:-}"; shift 2 ;;
    --host-repo) HOST_REPO="${2:-}"; shift 2 ;;
    --set) EXTRAS+=("${2:-}"); shift 2 ;;
    --render-only) RENDER_ONLY="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option '$1'" >&2; exit "$EXIT_CONFIG" ;;
  esac
done

if [ "$ALL" = "1" ] && [ -n "$CLIENT" ]; then
  echo "install.sh: --all and --client are mutually exclusive. --all installs what is present; --client names one." >&2
  exit "$EXIT_CONFIG"
fi

if [ "$ALL" != "1" ]; then
  case "$CLIENT" in
    claude|codex|hermes|pi) ;;
    "") echo "install.sh: --client is required (claude|codex|hermes|pi), or use --all" >&2; exit "$EXIT_CONFIG" ;;
    *) echo "install.sh: unknown client '$CLIENT'" >&2; exit "$EXIT_CONFIG" ;;
  esac
fi

if [ -z "$ENDPOINT" ]; then
  echo "install.sh: --endpoint is required. A wrapper will not guess where its service lives." >&2
  exit "$EXIT_CONFIG"
fi

[ -n "$BRIDGE_DIR" ] || BRIDGE_DIR="$NATIVE_BASE/mcp/stdio"
[ -n "$HOST_REPO" ] || HOST_REPO="$NATIVE_BASE"

[ -n "$REGISTRY" ] || REGISTRY="$HOME/.aify/services.json"

VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"

# What this launcher is being built from, baked in so anything holding the CURRENT registry can see
# the launcher is stale without executing it. An absent registry is a legitimate host state and
# fingerprints as the empty registry; a MALFORMED one stops the install here rather than producing a
# launcher built against whatever survived parsing.
if ! command -v node >/dev/null 2>&1; then
  echo "install.sh: node is required to read the service registry ($REGISTRY)." >&2
  exit "$EXIT_NO_RUNTIME"
fi
REGISTRY_FINGERPRINT="$(node "$HERE/lib/registry-cli.mjs" fingerprint "$REGISTRY")" || exit "$EXIT_CONFIG"
# Services that opted into strict mode, base64 so no path metacharacter survives the trip. Empty
# unless a service asked, which keeps strict mode byte-identical on every host that did not.
STRICT_EXTRA_MCP_B64="$(node "$HERE/lib/registry-cli.mjs" strict-fragment-b64 "$REGISTRY")" || exit "$EXIT_CONFIG"

# The launcher name follows the client name. pi is the one exception: it ships an alias, which is real
# information and not derivable from a filename, so it is the only thing written down here.
names_for_client() {
  case "$1" in
    pi) echo "pi-aify omp-aify" ;;
    *)  echo "$1-aify" ;;
  esac
}

install_one() {
  local client="$1"
  local out_dir="${RENDER_ONLY:-$DEST}"
  local primary=""
  local name target
  local -a extras=(${EXTRAS[@]+"${EXTRAS[@]}"})

  # Hermes needs three values only its host can compute: a plugin path converted for a native-Windows
  # runtime, a bridge dir in a form Git-Bash node can open, and a prebuilt TUI bundle that is baked
  # only when it exists. Defaulting them to empty keeps `--set` optional for a host that has none of
  # them; hermes treats an empty TUI dir as "locate or build it as before", which never breaks.
  #
  # Computed per client rather than once: under --all these must not leak into pi's render.
  if [ "$client" = "hermes" ]; then
    _have() { printf '%s\n' "${extras[@]:-}" | grep -q "^$1="; }
    _have HERMES_PLUGIN_PATH || extras+=("HERMES_PLUGIN_PATH=$HOST_REPO/integrations/hermes-aify-plugin")
    _have HERMES_STDIO_DIR   || extras+=("HERMES_STDIO_DIR=$BRIDGE_DIR")
    _have HERMES_TUI_DIR     || extras+=("HERMES_TUI_DIR=")
  fi

  for name in $(names_for_client "$client"); do
    target="$out_dir/$name"
    if [ -z "$primary" ]; then
      bash "$HERE/render.sh" "$client-aify.sh.in" "$target" \
        "ENDPOINT=$ENDPOINT" \
        "WRAPPER_VERSION=$VERSION" \
        "REGISTRY_FINGERPRINT=$REGISTRY_FINGERPRINT" \
        "STRICT_EXTRA_MCP_B64=$STRICT_EXTRA_MCP_B64" \
        "BRIDGE_DIR=$BRIDGE_DIR" \
        "NATIVE_BASE=$NATIVE_BASE" \
        "SCRIPT_DIR=$HOST_REPO" \
        ${extras[@]+"${extras[@]}"}
      primary="$target"
    else
      # pi ships an alias; the launcher reads its own name, so a copy is the whole difference.
      cp "$primary" "$target"
      chmod +x "$target"
    fi
    echo "wrote $target"
  done
}

CLIENTS=()
SKIPPED=()

if [ "$ALL" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "install.sh: --all needs node to detect which harnesses are present. Install node, or name one with --client." >&2
    exit "$EXIT_NO_RUNTIME"
  fi
  while IFS=$'\t' read -r _client _state _path; do
    [ -n "$_client" ] || continue
    if [ "$_state" = "found" ]; then CLIENTS+=("$_client"); else SKIPPED+=("$_client"); fi
  done < <(node "$HERE/lib/detect-cli.mjs" "$HERE/wrappers")

  # Silence about a skip reads as "installed everything" when it did not. Name every one.
  if [ "${#SKIPPED[@]}" -gt 0 ]; then
    for _client in "${SKIPPED[@]}"; do
      echo "skipped $_client: no '$_client' runtime on PATH"
    done
  fi

  if [ "${#CLIENTS[@]}" -eq 0 ]; then
    echo "install.sh: no harness runtime found on PATH, so no launcher would be usable." >&2
    exit "$EXIT_NO_RUNTIME"
  fi
else
  CLIENTS=("$CLIENT")
fi

for _client in "${CLIENTS[@]}"; do
  install_one "$_client"
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
echo "Installed wrapper $VERSION for: ${CLIENTS[*]}. Verify without starting anything:"
for _client in "${CLIENTS[@]}"; do
  echo "  $(names_for_client "$_client" | awk '{print $1}') --check"
done
