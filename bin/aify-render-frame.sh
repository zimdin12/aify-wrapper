#!/bin/bash
# One existing Bash child: read exact data from stdin, then source the renderer with its unchanged argv contract.
set -euo pipefail
_aify_bad_frame() { printf 'render frame refused: incomplete or invalid framing.\n' >&2; exit 78; }
IFS= read -r -d '' _aify_count || _aify_bad_frame
[[ "$_aify_count" =~ ^[1-9][0-9]*$ ]] || _aify_bad_frame
_aify_fields=()
while IFS= read -r -d '' _aify_field; do _aify_fields+=("$_aify_field"); done
[ -z "${_aify_field:-}" ] || _aify_bad_frame
[ "${#_aify_fields[@]}" = "$_aify_count" ] && [ "${#_aify_fields[@]}" -ge 3 ] || _aify_bad_frame
[ -n "${_aify_fields[0]}" ] && [ -n "${_aify_fields[1]}" ] && [ -n "${_aify_fields[2]}" ] || _aify_bad_frame
_aify_renderer="${_aify_fields[0]}"
set -- "${_aify_fields[@]:1}"
. "$_aify_renderer"
