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

# AN & IN A VALUE IS A LITERAL &, NOT THE MATCHED TEXT (R9-M12, external review 2026-09-06).
#
# bash 5.2 added `patsub_replacement`, ON BY DEFAULT, which makes an unquoted `&` in the replacement
# half of `${var//pat/repl}` expand to whatever the pattern matched. So rendering an endpoint that
# carries a query string -- `http://host/p?a=1&b=2` -- produced `http://host/p?a=1@@ENDPOINT@@b=2`.
# The placeholder was still there afterwards, so the unsubstituted-placeholder check below fired and
# exited 78 blaming the TEMPLATE for a value the renderer had mangled. That message sends the reader
# to the wrong file.
#
# Turned off rather than escaped at each site: escaping is a rule every future substitution has to
# remember, and this shell option is the thing that made a plain value special in the first place.
# Guarded because bash 5.1 and earlier do not know the option and `shopt -u` on an unknown name is
# an error under `set -e`.
shopt -u patsub_replacement 2>/dev/null || true

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
# CREATED PRIVATE, THEN OPENED, rather than written at the umask's mercy and tightened afterwards.
# `chmod` runs after the bytes are on disk, so a launcher carrying a secret is world-readable for the
# window in between -- short, and on a shared host long enough. `umask` applies at creation.
(
  umask 077
  printf '%s\n' "$text" > "$target"
)

# A LAUNCHER THAT CARRIES A SECRET STAYS PRIVATE. `keyEnv` values are baked in at render time -- the
# MCP `env` block REPLACES the inherited environment for that server, so the value has to be in the
# file -- and `chmod +x` under the usual umask makes that file 0755. Everyone on the host can then
# read a service credential out of a launcher.
#
# The check is on the CONTENT, not on a flag the caller passes, because the caller that bakes the
# secret and the caller that sets the mode would otherwise be two places to keep in step. A rendered
# launcher with no baked credential keeps 0755: these are meant to be runnable, and tightening every
# one of them would break a genuinely shared install for a risk it does not carry.
# MEASURED against a real render rather than guessed. The placeholder is substituted INLINE, so the
# variable name is gone from the output: an ordinary launcher carries `printf '%s' "" | base64 -d`
# and one with servers to splice in carries the blob in that position. The name-based check written
# first would have matched neither, and would have reported every launcher as secret-free.
if grep -qE '[A-Za-z0-9+/=]{8,}" \| base64 -d' "$target" 2>/dev/null; then
  chmod 700 "$target"
else
  # 755, SAID RATHER THAN IMPLIED. This was `chmod +x`, which only ADDS the execute bit to whatever
  # the file was created with -- 0600 from the writer, so the result was 0711, not the 0755 the
  # comment above promises. External review, Round 8 M2, measured against the prior commit.
  #
  # 0711 is worse than it looks for a SHELL SCRIPT: other users may execute it and not READ it, and
  # an interpreter has to read a script to run it. So "executable by everyone" was true of the bits
  # and false of the behaviour, which is the shape a mode check catches only if it reads the whole
  # mode. The test beside this one checked `mode & 0o100` -- the OWNER's bit -- and passed on 0711.
  chmod 755 "$target"
fi
