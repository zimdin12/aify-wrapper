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
#   --wrapper-dir <dir>    where launchers find this package's bin/ and lib/ (default: this package)
#   --host-repo <dir>      host checkout, for hooks that must run from source
#   --set KEY=VALUE        extra placeholder, repeatable (hermes needs three; see README)
#   --registry <path>      service registry to build against (default: ~/.aify/services.json)
#   --render-only <dir>    write the launchers into <dir> and exit, touching nothing else
#
# Exit codes match the contract the wrappers themselves use: 78 configuration invalid, 127 a required
# command is missing.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A path this script hands to NODE, in the form Node can read.
#
# Under Git-Bash `pwd` yields an MSYS path like /c/Users/... , which Windows Node resolves against
# the C: drive with the whole POSIX path appended, and cannot find. It works in an ordinary
# interactive shell only because MSYS rewrites path-shaped arguments on their way to a native
# binary -- a behaviour of the shell, not of this script. Anything that turns that off
# (MSYS2_ARG_CONV_EXCL, MSYS_NO_PATHCONV, bash invoked from a non-MSYS parent) made the installer
# exit 78 before writing a launcher. Found in review; the suite could not see it because every test
# ran through a shell that was quietly rescuing it.
#
# `cygpath -m` gives a native drive with forward slashes, which Node reads and which needs no
# quoting games here. On any non-Windows shell the path is already native and passes straight
# through, so this is a no-op off Windows.
node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf %s "$1"
  fi
}
EXIT_CONFIG=78
EXIT_NO_RUNTIME=127

ALL=0
CLIENT=""
ENDPOINT=""
DEST="$HOME/.local/bin"
NATIVE_BASE=""
BRIDGE_DIR=""
WRAPPER_DIR=""
HOST_REPO=""
RENDER_ONLY=""
REGISTRY=""
# How the runtime reaches MCP. `stdio` spawns the service's own bridge locally, which is the only
# reason a host carries a copy of it; `http` reaches the service's <endpoint>/mcp/http. A transport the
# service declares in the registry wins (below). Default stdio: repointing a live fleet is the operator's
# call, and a launcher rendered today must be byte-identical to one rendered before this existed.
MCP_TRANSPORT="stdio"
# WHICH SERVICE these launchers are for. aify-comms by default, which is what every existing install
# renders -- the point of the default is that this change is invisible to them.
SERVICE_NAME="aify-comms"
EXTRAS=()

# Empty is a supplied value; paths may even spell an option. Only enum/URL values cannot be option tokens.
need_value() {
  local option="$1"
  if [ $# -ge 2 ]; then
    case "$option" in
      --client|--endpoint|--mcp-transport) case "$2" in --*|-h) ;; *) return 0 ;; esac ;;
      *) return 0 ;;
    esac
  fi
  echo "install.sh: $option needs a value" >&2
  exit "$EXIT_CONFIG"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --client) need_value "$@"; CLIENT="${2:-}"; shift 2 ;;
    --endpoint) need_value "$@"; ENDPOINT="${2:-}"; shift 2 ;;
    --dest) need_value "$@"; DEST="${2:-}"; shift 2 ;;
    --bridge-dir) need_value "$@"; BRIDGE_DIR="${2:-}"; shift 2 ;;
    --native-base) need_value "$@"; NATIVE_BASE="${2:-}"; shift 2 ;;
    --wrapper-dir) need_value "$@"; WRAPPER_DIR="${2:-}"; shift 2 ;;
    --host-repo) need_value "$@"; HOST_REPO="${2:-}"; shift 2 ;;
    --set) need_value "$@"; EXTRAS+=("${2:-}"); shift 2 ;;
    --render-only) need_value "$@"; RENDER_ONLY="${2:-}"; shift 2 ;;
    --registry) need_value "$@"; REGISTRY="${2:-}"; shift 2 ;;
    --mcp-transport) need_value "$@"; MCP_TRANSPORT="${2:-}"; shift 2 ;;
    # The channel name is DERIVED from this rather than taken separately: two names that must agree
    # are a defect with a delay on it.
    --service) need_value "$@"; SERVICE_NAME="${2:-}"; shift 2 ;;
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

# A FIRST install will not guess an address: an agent pointed at the wrong service is worse than an
# install that stopped. A REINSTALL is a different question -- the endpoint is already baked into the
# launcher sitting in $DEST, so updating does not mean remembering what you typed months ago. Read out
# of the file, never by running the launcher, which would start a coding-agent runtime to ask.
if [ -z "$ENDPOINT" ] && [ -z "$RENDER_ONLY" ] && command -v node >/dev/null 2>&1; then
  ENDPOINT="$(node "$(node_path "$HERE/lib/installed-endpoint-cli.mjs")" "$(node_path "$DEST")" 2>/dev/null || true)"
  # Silently reusing an address is how a launcher ends up pointing somewhere nobody chose. Say it.
  [ -z "$ENDPOINT" ] || echo "install.sh: reusing the endpoint already installed in $DEST: $ENDPOINT" >&2
fi

case "$SERVICE_NAME" in
  "") echo "install.sh: --service needs a name" >&2; exit "$EXIT_CONFIG" ;;
  # The name lands in a JSON key AND a shell word, so it is held to what both take without quoting
  # games. Refusing costs nothing; the alternative is a launcher that breaks when it is read.
  *[!A-Za-z0-9_-]*)
    echo "install.sh: --service '$SERVICE_NAME' may use letters, digits, _ and - only" >&2
    exit "$EXIT_CONFIG" ;;
esac

case "$MCP_TRANSPORT" in
  stdio|http) ;;
  *) echo "install.sh: unknown --mcp-transport '$MCP_TRANSPORT' (stdio|http)" >&2; exit "$EXIT_CONFIG" ;;
esac

if [ -z "$ENDPOINT" ]; then
  echo "install.sh: --endpoint is required. A wrapper will not guess where its service lives." >&2
  exit "$EXIT_CONFIG"
fi

# WHERE THIS SERVICE'S RUNTIME LIVES, derived from WHOSE it is.
#
# This was `$HOME/.aify-comms`, set before the arguments were parsed -- so `--service my-service`
# with no `--native-base` rendered a launcher for my-service that pointed its bridge directory,
# its host repo and codex's log root at AIFY-COMMS' dotfolder. Silently: every other name in the
# launcher followed the service correctly, and only the paths pointed at a neighbour.
#
# Identity and location are still different axes and `--native-base` still wins outright. What
# changed is the DEFAULT, which named one service and was therefore right for exactly one caller.
# Derived, it is right for all of them, and the default render is byte-identical because
# SERVICE_NAME defaults to aify-comms.
#
# Placed after the SERVICE_NAME validation on purpose: that check refuses an empty name and
# anything outside [A-Za-z0-9_-], so this cannot build a path out of a name a shell would reinterpret.
[ -n "$NATIVE_BASE" ] || NATIVE_BASE="$HOME/.$SERVICE_NAME"

[ -n "$BRIDGE_DIR" ] || BRIDGE_DIR="$NATIVE_BASE/mcp/stdio"
# THE LAUNCHERS FIND THEIR OWN HELPERS HERE: this package, wherever it is installed. Not under the bridge,
# which is a service's and holds only that service's code. render.sh takes no default for it, so a host that
# renders through a copy of render.sh cannot end up pointing its launchers at that copy's directory.
[ -n "$WRAPPER_DIR" ] || WRAPPER_DIR="$HERE"
# AND RESOLVED TO AN ABSOLUTE PATH NOW, because it is baked into the launcher and the launcher runs from whatever
# project it is started in: a relative `./wrapper copy` passed the reader check here and then refused every named
# launch elsewhere (review of 0.9.7). A directory that does not exist is refused before anything is written.
# CDPATH CLEARED AND cd SILENCED: with an exported CDPATH, `cd` searches it for a bare relative name, may pick a
# different directory of that name, and prints the one it picked, so the capture was "path<newline>path". The
# option means the install's cwd, and only pwd supplies the root. A root with a newline in it is refused regardless.
if ! _aify_wrapper_abs="$(CDPATH= cd -- "$WRAPPER_DIR" >/dev/null 2>&1 && pwd -P)"; then
  echo "install.sh: --wrapper-dir '$WRAPPER_DIR' is not a directory." >&2
  exit "$EXIT_CONFIG"
fi
case "$_aify_wrapper_abs" in
  *$'\n'*) echo "install.sh: --wrapper-dir '$WRAPPER_DIR' resolved to a path with a newline in it." >&2; exit "$EXIT_CONFIG" ;;
esac
WRAPPER_DIR="$_aify_wrapper_abs"
[ -n "$HOST_REPO" ] || HOST_REPO="$NATIVE_BASE"

[ -n "$REGISTRY" ] || REGISTRY="$HOME/.aify/services.json"

VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"

# Node reads the service registry and detects the runtimes, so the install stops here without it.
if ! command -v node >/dev/null 2>&1; then
  echo "install.sh: node is required to read the service registry ($REGISTRY)." >&2
  exit "$EXIT_NO_RUNTIME"
fi
# The launcher name follows the client name, then any alias wrappers/aliases names for it (pi's omp-aify): real
# information, not derivable from a filename, written down once for this installer and connect's re-render.
names_for_client() {
  echo "$1-aify" $(awk -v launcher="$1-aify" '$1 == launcher { $1 = ""; print }' "$HERE/wrappers/aliases")
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
    # A native-Windows hermes is Python, which reads the same drive form Node does (`node_path`).
    _have HERMES_PLUGIN_PATH || extras+=("HERMES_PLUGIN_PATH=$(node_path "$HOST_REPO/integrations/hermes-aify-plugin")")
    _have HERMES_STDIO_DIR   || extras+=("HERMES_STDIO_DIR=$BRIDGE_DIR")
    _have HERMES_TUI_DIR     || extras+=("HERMES_TUI_DIR=")
  fi

  for name in $(names_for_client "$client"); do
    target="$out_dir/$name"
    if [ -z "$primary" ]; then
      bash "$HERE/render.sh" "$client-aify.sh.in" "$target" \
        "ENDPOINT=$ENDPOINT" \
        "WRAPPER_VERSION=$VERSION" \
        "${AIFY_REGISTRY_RENDER_PAIRS[@]}" \
        "SERVICE_NAME=$SERVICE_NAME" \
        "BRIDGE_DIR=$BRIDGE_DIR" \
        "WRAPPER_DIR=$WRAPPER_DIR" \
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

if [ "$ALL" = "1" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "install.sh: --all needs node to detect which harnesses are present. Install node, or name one with --client." >&2
    exit "$EXIT_NO_RUNTIME"
  fi
  while IFS= read -r _row; do
    IFS=$'\t' read -r _client _state _rest <<< "$_row"
    [ -n "$_client" ] || continue
    # read's tab IFS collapses an empty path. The command is always the final field instead.
    _command="${_row##*$'\t'}"
    if [ "$_state" = "found" ]; then
      CLIENTS+=("$_client")
    elif [ "$_state" = "invalid" ]; then
      echo "skipped $_client: invalid or ambiguous runtime default in template"
    else
      echo "skipped $_client: no '$_command' runtime on PATH"
    fi
  done < <(node "$(node_path "$HERE/lib/detect-cli.mjs")" "$(node_path "$HERE/wrappers")")

  if [ "${#CLIENTS[@]}" -eq 0 ]; then
    echo "install.sh: no harness runtime found on PATH, so no launcher would be usable." >&2
    exit "$EXIT_NO_RUNTIME"
  fi
else
  CLIENTS=("$CLIENT")
fi

# A LAUNCHER THAT READS DEFINITIONS IS NOT WRITTEN AHEAD OF ITS READER. It reads an agent's definition with
# bin/aify-definition.mjs, through bin/aify-definition.sh, in the wrapper directory it was rendered with, and refuses
# (78) when either is missing. The reader is this package's own, so it is there unless --wrapper-dir names a directory
# without it, which is refused here before anything is written. (It once lived in the service's bridge, and launchers
# written before the service's install started nothing until it ran: external review of 0.8.1.)
# WHICH LAUNCHERS READ is taken from their templates, not listed: pi's does not (review of 0.8.2). The check is
# that the reader's files exist, not that they run. --render-only is left to its caller.
READING_CLIENTS=()
for _client in "${CLIENTS[@]}"; do
  if grep -q "bin/aify-definition.sh" "$HERE/wrappers/$_client-aify.sh.in" 2>/dev/null; then READING_CLIENTS+=("$_client"); fi
done
if [ -z "$RENDER_ONLY" ] && [ "${#READING_CLIENTS[@]}" -gt 0 ] \
  && { [ ! -f "$WRAPPER_DIR/bin/aify-definition.mjs" ] || [ ! -f "$WRAPPER_DIR/bin/aify-definition.sh" ]; }; then
  echo "install.sh: $WRAPPER_DIR has no definition reader (bin/aify-definition.mjs and bin/aify-definition.sh)," >&2
  echo "            so the ${READING_CLIENTS[*]} launcher written now would refuse to start a named agent." >&2
  echo "            Point --wrapper-dir at an installed aify-wrapper, or leave it out to use this one." >&2
  exit "$EXIT_CONFIG"
fi
# THE SAME FOR THE HELPERS A LAUNCHER SKIPS WITHOUT A WORD: Herdr's claim and profile (bin/aify-herdr-launch.sh) and
# hermes' Node >= 22 (bin/aify-node-22.sh). Neither can fail a launch, so a --wrapper-dir without one would install
# launchers that silently lose what it does. Which launchers need which is read from their templates. The same for
# the pending hermes config step (bin/aify-hermes-pending-config.mjs), without which a recorded change is never applied.
# Input validation and launcher common functions are required too: missing ones refuse rather than lose behavior.
if [ -z "$RENDER_ONLY" ]; then
  for _helper in aify-herdr-launch.sh aify-node-22.sh aify-hermes-pending-config.mjs aify-input-boundary.sh aify-launcher-common.sh; do
    _needing=()
    for _client in "${CLIENTS[@]}"; do
      if grep -q "bin/$_helper" "$HERE/wrappers/$_client-aify.sh.in" 2>/dev/null; then _needing+=("$_client"); fi
    done
    if [ "${#_needing[@]}" -gt 0 ] && [ ! -f "$WRAPPER_DIR/bin/$_helper" ]; then
      echo "install.sh: $WRAPPER_DIR has no bin/$_helper, which the ${_needing[*]} launcher sources." >&2
      echo "            Point --wrapper-dir at an installed aify-wrapper, or leave it out to use this one." >&2
      exit "$EXIT_CONFIG"
    fi
  done
fi

# THE REGISTRY IS READ ONLY ONCE THE INSTALL IS KNOWN TO BE VALID: after the client set and every --wrapper-dir check
# above, so a misconfigured install refuses without a node start or a registry read. What it reads is baked in so
# anything holding the CURRENT registry can see a launcher is stale without executing it. An absent registry is a
# legitimate host state and fingerprints as the empty registry; a MALFORMED one stops the install here, before any
# launcher is written, rather than producing one built against whatever survived parsing.
# Each path node reads, converted once (a cygpath start costs 100-500 ms on a loaded Windows host).
REGISTRY_CLI="$(node_path "$HERE/lib/registry-cli.mjs")"
REGISTRY_NATIVE="$(node_path "$REGISTRY")"
# One registry read; required/optional names come from the renderer's categorized block, not another list.
# The helper clears required values before reading and refuses missing results, including inherited ones.
. "$HERE/bin/aify-registry-pair-categories.sh" || exit "$EXIT_CONFIG"
aify_registry_pair_categories_read "$HERE/render.sh" || exit "$EXIT_CONFIG"
aify_registry_install_pairs_clear
_pairs="$(node "$REGISTRY_CLI" install-pairs "$REGISTRY_NATIVE" "$SERVICE_NAME" "$MCP_TRANSPORT")" || exit "$EXIT_CONFIG"
aify_registry_install_pairs_apply "$_pairs" || exit "$EXIT_CONFIG"

# The same session services for codex, as NUL-terminated `-c` words in base64, built only when a codex
# launcher is being written. What the verb refuses is codex's own limit (a server name that is not a bare
# TOML key, a key kept in a variable codex forwards), so it stops a codex install and never a claude, hermes
# or pi one; the refusals every client shares come from the parse above. Here, after the client set is known
# and before the first launcher is written, so `--all` refuses before it writes anything.
SESSION_MCP_CODEX_B64=""
for _client in "${CLIENTS[@]}"; do
  if [ "$_client" = "codex" ]; then
    SESSION_MCP_CODEX_B64="$(node "$REGISTRY_CLI" session-codex-b64 "$REGISTRY_NATIVE")" || exit "$EXIT_CONFIG"
  fi
  # Hermes has no per-session MCP flag, so its session servers go into the USER'S hermes config, which every hermes
  # session on this host reads (docs/REGISTRY.md). What hermes could never be given is refused here, before any
  # launcher is written; the write itself is the hermes step after the launchers.
  if [ "$_client" = "hermes" ]; then
    node "$(node_path "$HERE/lib/hermes-config-cli.mjs")" --check "$REGISTRY_NATIVE" || exit "$EXIT_CONFIG"
  fi
done

# WHAT EACH LAUNCHER WAS RENDERED FROM, beside the registry it was built against, so `aify-wrapper-connect` can
# re-render it after a service is connected without guessing these values. Not for --render-only, which touches
# nothing outside the directory it was given.
if [ -z "$RENDER_ONLY" ]; then
  RENDER_RECORD_DIR="$(dirname "$REGISTRY")/launchers"
  export RENDER_RECORD_DIR
fi

aify_registry_render_pairs
for _client in "${CLIENTS[@]}"; do
  install_one "$_client"
done

# --render-only writes launchers and nothing else, so it never touches the user's hermes config.
if [ -n "$RENDER_ONLY" ]; then
  exit 0
fi

for _client in "${CLIENTS[@]}"; do
  if [ "$_client" = "hermes" ]; then
    # Its own step, named when it fails: the hermes launcher is installed either way, and works without the servers.
    # WRITTEN ONLY WHAT CHANGED, AND ONLY IF NO HERMES RUNS (lib/hermes-config-cli.mjs, the step aify-comms' installer
    # runs too): a running hermes reloads its servers when their content changes, so with hermes agents up the change
    # is recorded and waits for the first hermes start that finds none. A config already current records nothing.
    _status=0
    node "$(node_path "$HERE/lib/hermes-config-cli.mjs")" "$REGISTRY_NATIVE" || _status=$?
    if [ "$_status" != 0 ]; then
      echo "install.sh: the hermes launcher is installed, but the hermes config step above did not finish (exit $_status)." >&2
      exit "$EXIT_CONFIG"
    fi
  fi
done

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
