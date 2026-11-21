#!/usr/bin/env bash
# One full run before a wrapper pin or tag, from Windows Git Bash.
#   scripts/test-linux.sh [--log FILE]
#   scripts/test-linux.sh [--worktree] [--log FILE] tests/<file>.test.js ...
#   scripts/test-linux.sh --packed-only [--worktree] [--log FILE]
# The full run qualifies one packed tarball on native Windows and in the Linux container.
# Targeted runs and --worktree are development checks, not full release receipts.
# --packed-only needs no sibling checkouts; it exercises just the two packed-key legs.
set -euo pipefail

IMAGE="node:22.20.0-bookworm"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
worktree=false
packed_only=false
log=""
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) worktree=true ;;
    --packed-only) packed_only=true ;;
    --log) log="${2:?--log needs a file}"; shift ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 0 ;;
    tests/*.test.js) files+=("$1") ;;
    *) echo "test-linux: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

qualify=false
if $packed_only; then
  [ "${#files[@]}" -eq 0 ] || { echo 'test-linux: --packed-only takes no test selectors' >&2; exit 2; }
  IMAGE="${AIFY_TEST_PACKED_IMAGE:-$IMAGE}"
  qualify=true
elif ! $worktree && [ "${#files[@]}" -eq 0 ]; then
  qualify=true
fi

not_run() { printf '%s\n' "NOT_RUN: $*" >&2; return 2; }
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf %s "$1"; fi; }

stage="$(mktemp -d "${TMPDIR:-/tmp}/aify-wrapper-linux-XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
mount="$(native "$stage")"
wrapper_sha="$(git -C "$HERE" rev-parse HEAD)"
if $worktree; then
  wrapper_sha="$wrapper_sha + working tree"
  tar -C "$HERE" --exclude=.git --exclude=node_modules --exclude=./.check-output -cf "$stage/wrapper.tar" .
else
  git -C "$HERE" archive -o "$stage/wrapper.tar" "$wrapper_sha"
fi

prepare_packed() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { not_run 'the packed qualification needs Node and npm'; return 2; }
  [ "$(node -p process.platform)" = win32 ] || { not_run 'the required native Windows ACL leg must run from Windows Git Bash'; return 2; }
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { not_run "required Docker image is not cached: $IMAGE (no pull attempted)"; return 2; }
  mkdir -p "$stage/wrapper" "$stage/npm-cache"
  tar -xf "$stage/wrapper.tar" -C "$stage/wrapper"
  local source="$mount/wrapper" artifact="$mount/wrapper-candidate.tgz"
  PACKED_DIGEST="$(node "$source/scripts/pack-wrapper-candidate.mjs" "$source" "$artifact")" || return 2
  [[ "$PACKED_DIGEST" =~ ^[a-f0-9]{64}$ ]] || { not_run 'packer returned no candidate SHA-256'; return 2; }
  printf '%s\n' "wrapper candidate SHA-256 $PACKED_DIGEST"
  (
    cd "$stage/wrapper" || exit 2
    export NPM_CONFIG_CACHE="$mount/npm-cache"
    npm ci --global=false --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null || { not_run 'Windows npm ci could not provision the locked dependency'; exit 2; }
    export AIFY_REQUIRE_PACKED_WRAPPER=1 AIFY_PACKED_WRAPPER_TARBALL="$artifact" AIFY_PACKED_WRAPPER_SHA256="$PACKED_DIGEST"
    env -u AIFY_AGENT_ID -u AIFY_AGENT_LEASE -u AIFY_ENV_INSTANCE -u AIFY_LIFETIME npm test -- tests/packed-session-key.test.js
  )
}

archive_peers() {
  local comms="${AIFY_COMMS_REPO:-$HERE/../aify-comms}" env_repo="${AIFY_ENV_REPO:-$HERE/../aify-env}" comms_sha env_sha
  comms_sha="$(git -C "$comms" rev-parse --verify -q HEAD)" || { not_run 'aify-comms checkout unavailable (set AIFY_COMMS_REPO)'; return 2; }
  env_sha="$(git -C "$env_repo" rev-parse --verify -q HEAD)" || { not_run 'aify-env checkout unavailable (set AIFY_ENV_REPO)'; return 2; }
  git -C "$comms" archive -o "$stage/comms.tar" "$comms_sha" || return $?
  git -C "$env_repo" archive -o "$stage/env.tar" "$env_sha" || return $?
  printf '%s\n' "AIFY_COMMS_REPO=comms $comms_sha, AIFY_ENV_REPO=aify-env $env_sha"
}

linux_leg() {
  local container="${stage##*/}"
  local -a docker_args=(--rm --name "$container" --user node -v "$mount:/in:ro")
  printf '%s\n' "test container $container (--rm)"
  if $qualify; then
    docker_args+=(--pull=never -e AIFY_REQUIRE_PACKED_WRAPPER=1 -e AIFY_PACKED_WRAPPER_TARBALL=/in/wrapper-candidate.tgz -e AIFY_PACKED_WRAPPER_SHA256="$PACKED_DIGEST")
  fi
  if $packed_only; then docker_args+=(--network=none); fi
  MSYS_NO_PATHCONV=1 docker run "${docker_args[@]}" "$IMAGE" bash -c '
    set -e; mkdir -p /tmp/work/wrapper
    tar -xf /in/wrapper.tar -C /tmp/work/wrapper
    cd /tmp/work/wrapper
    export NPM_CONFIG_CACHE=/tmp/work/npm-cache
    if [ "$1" = true ]; then
      cp -R /in/npm-cache "$NPM_CONFIG_CACHE"
      npm test -- tests/packed-session-key.test.js
    else
      export AIFY_COMMS_REPO=/tmp/work/comms AIFY_ENV_REPO=/tmp/work/aify-env
      mkdir -p "$AIFY_COMMS_REPO" "$AIFY_ENV_REPO"
      tar -xf /in/comms.tar -C "$AIFY_COMMS_REPO"; tar -xf /in/env.tar -C "$AIFY_ENV_REPO"
      if [ -n "${AIFY_PACKED_WRAPPER_TARBALL:-}" ] && [ ! -f tests/packed-session-key.test.js ]; then
        echo "NOT_RUN: required packed test is missing" >&2; exit 2
      fi
      node --version && npm ci --no-audit --no-fund >/dev/null
      shift
      npm test -- "$@"
    fi' test-linux "$packed_only" ${files[@]+"${files[@]}"}
}

run() {
  printf '%s\n' "wrapper $wrapper_sha; image $IMAGE; started $(date -u +%FT%TZ)"
  local status=0
  command -v docker >/dev/null 2>&1 || { not_run 'docker unavailable' || status=$?; }
  if [ "$status" -eq 0 ] && ! $packed_only; then archive_peers || status=$?; fi
  if [ "$status" -eq 0 ] && $qualify; then prepare_packed || status=$?; fi
  if [ "$status" -eq 0 ]; then
    linux_leg || status=$?
    case "$status" in 125|126|127) not_run 'Docker could not run the Linux leg' || : ;; esac
  fi
  printf '%s\n' "ACTUAL_EXIT=$status finished $(date -u +%FT%TZ)"
  return "$status"
}

if [ -n "$log" ]; then
  run > "$log" 2>&1 || { status=$?; tail -n 12 "$log"; exit "$status"; }
  tail -n 12 "$log"
else
  run
fi
