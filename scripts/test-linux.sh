#!/usr/bin/env bash
# Run this package's suite on Linux, in a container, from committed trees: the full run before a pin or a tag.
#
#   scripts/test-linux.sh [--worktree] [--log FILE] [tests/<file>.test.js ...]
#
# The same 1337 tests take about a minute here and about 800 s on Windows, where every process start costs 100-500 ms
# under load. Windows keeps a short subset of its own (scripts/windows-only-tests.mjs).
#
# WHAT RUNS. `git archive HEAD` of this repo, of aify-comms (AIFY_COMMS_REPO, else ../aify-comms) and of aify-env
# (AIFY_ENV_REPO, else ../aify-env), unpacked in a node container and run with `npm ci && npm test`. Committed trees,
# so the run is of shas a reviewer can name; --worktree takes this repo's working tree instead (not .git, not
# node_modules), for a change not yet committed. Nothing is mounted writable, and nothing here touches this machine's
# HOME: the container has its own, and the suite seals one inside it as well.
#
# THE LOG starts with every sha and the image, and ends with ACTUAL_EXIT, the exit status of `npm test` itself.
set -euo pipefail

IMAGE="node:22.20.0-bookworm"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worktree=false
log=""
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) worktree=true ;;
    --log) log="${2:?--log needs a file}"; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    tests/*.test.js) files+=("$1") ;;
    *) echo "test-linux: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || { echo "test-linux: docker is not on PATH" >&2; exit 127; }
comms="${AIFY_COMMS_REPO:-$HERE/../aify-comms}"
env_repo="${AIFY_ENV_REPO:-$HERE/../aify-env}"
for repo in "$comms" "$env_repo"; do
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null || { echo "test-linux: not a git checkout: $repo (set AIFY_COMMS_REPO / AIFY_ENV_REPO)" >&2; exit 2; }
done

stage="$(mktemp -d "${TMPDIR:-/tmp}/aify-wrapper-linux-XXXXXX")"
trap 'rm -rf "$stage"' EXIT
if $worktree; then
  wrapper_sha="$(git -C "$HERE" rev-parse HEAD) + working tree"
  tar -C "$HERE" --exclude=.git --exclude=node_modules -cf "$stage/wrapper.tar" .
else
  wrapper_sha="$(git -C "$HERE" rev-parse HEAD)"
  git -C "$HERE" archive -o "$stage/wrapper.tar" HEAD
fi
git -C "$comms" archive -o "$stage/comms.tar" HEAD
git -C "$env_repo" archive -o "$stage/env.tar" HEAD
header="wrapper $wrapper_sha, AIFY_COMMS_REPO=comms $(git -C "$comms" rev-parse HEAD), AIFY_ENV_REPO=aify-env $(git -C "$env_repo" rev-parse HEAD); image $IMAGE; npm ci && npm test ${files[*]:-}; started $(date -u +%FT%TZ)"

# Git Bash would rewrite the container's /paths into Windows ones; nothing here wants that.
mount="$stage"
if command -v cygpath >/dev/null 2>&1; then mount="$(cygpath -m "$stage")"; fi
run() {
  echo "$header"
  status=0
  MSYS_NO_PATHCONV=1 docker run --rm --user node -v "$mount:/in:ro" -e AIFY_COMMS_REPO=/tmp/work/comms -e AIFY_ENV_REPO=/tmp/work/aify-env \
    "$IMAGE" bash -c 'set -e; mkdir -p /tmp/work/wrapper /tmp/work/comms /tmp/work/aify-env
      tar -xf /in/wrapper.tar -C /tmp/work/wrapper; tar -xf /in/comms.tar -C /tmp/work/comms; tar -xf /in/env.tar -C /tmp/work/aify-env
      cd /tmp/work/wrapper && node --version && npm ci --no-audit --no-fund >/dev/null && npm test -- "$@"' test-linux ${files[@]+"${files[@]}"} || status=$?
  echo "ACTUAL_EXIT=$status finished $(date -u +%FT%TZ)"
  return "$status"
}
if [ -n "$log" ]; then
  run > "$log" 2>&1 || { status=$?; tail -n 12 "$log"; exit "$status"; }
  tail -n 12 "$log"
else
  run
fi
