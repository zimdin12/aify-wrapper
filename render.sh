#!/bin/bash
# Render one wrapper template into a runnable launcher.
#
# A template is ordinary bash with two additions: `@@TOKEN@@` placeholders that a host substitutes at
# install time, and `#|` lines that document the template and are stripped from the output. Everything
# else is copied byte for byte.
#
#   render.sh <template-name> <output-path> [KEY=VALUE ...]
#
# The KEY=VALUE pairs are the host's; `KEY=x` replaces `@@KEY@@`. Substitution is bash parameter
# expansion rather than sed, deliberately: the values are filesystem paths and URLs, and a `|` or `/`
# in one of them silently produces a broken launcher when sed is doing the work.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -lt 2 ]; then
  echo "usage: render.sh <template-name> <output-path> [KEY=VALUE ...]" >&2
  exit 78
fi

template="$HERE/wrappers/$1"
target="$2"
shift 2

if [ ! -f "$template" ]; then
  echo "render.sh: no such template: $template" >&2
  echo "available: $(cd "$HERE/wrappers" && ls *.sh.in | tr '\n' ' ')" >&2
  exit 78
fi

# `#|` lines are documentation for whoever edits the template. They never reach the launcher.
text="$(grep -v "^#|" "$template")"

for pair in "$@"; do
  case "$pair" in
    *=*) text="${text//@@${pair%%=*}@@/${pair#*=}}" ;;
    *)
      echo "render.sh: expected KEY=VALUE, got '$pair'" >&2
      exit 78
      ;;
  esac
done

# A placeholder the host did not supply would reach the launcher as literal `@@NAME@@` and fail at
# launch, long after the install reported success. Refuse here instead.
leftover="$(printf '%s\n' "$text" | grep -o '@@[A-Z0-9_]*@@' | sort -u | tr '\n' ' ' || true)"
if [ -n "${leftover// /}" ]; then
  echo "render.sh: template still contains unsubstituted placeholders: $leftover" >&2
  echo "           supply them as KEY=VALUE arguments." >&2
  exit 78
fi

mkdir -p "$(dirname "$target")"
printf '%s\n' "$text" > "$target"
chmod +x "$target"
