# Render and JSON input boundaries

`render.sh <template> <target> KEY=VALUE...` keeps its existing argv interface. It validates inputs
before publishing a launcher or render record. A refusal exits78 and leaves existing target/record
artifacts unchanged. New input-boundary diagnostics name the field or boundary, not its value. The renderer remains a
self-contained file: external installers may copy only `render.sh` beside `wrappers/<template>`.
Render validation is inline; it does not source a helper or know about the internal stdin carrier.

## Template values

Keys use the render-record grammar `^[A-Z0-9_]+$`. The value is everything after the first equals
sign. Literal double quote, dollar, backtick, closing brace and controls are unsupported shell-source
inputs and are refused, even for an unused key. Controls include ASCII C0/DEL and UTF-8 C1. NUL is
not an argv/env value and is not claimed as a renderer character check.

Current scalar slots are quoted assignments/arguments or heredoc scalars. Backslashes are encoded
once for those contexts, preserving ordinary Windows drive paths with spaces, UNC paths and trailing
separators. Render records keep raw pairs, never the encoded shell text, so a re-render does not
accumulate escaping. Ampersands remain literal; the renderer still disables Bash's patsub replacement
option. Slashes, pipes, percent signs, single quotes and Unicode are not broadly banned.

`SERVICE_NAME` also follows the existing installer grammar `[A-Za-z0-9_-]+`, because it appears as
an unquoted channel word as well as a JSON key. A new template must not treat arbitrary scalar slots
as shell code. Already-serialized registry fragments remain base64 across the source boundary;
their decoded JSON may contain escaped characters that are not valid raw template inputs.

## Runtime JSON scalars

Launchers source the common in-process validator. Resolved `HARNESS_ENDPOINT` rejects quote,
backslash and controls with78 before JSON construction, including on `--check`. Explicit-empty
endpoint behavior is unchanged. Wrapper/bridge forward-form roots are checked by the same scalar
rule after normal path conversion. A path that still has JSON-unsafe backslashes without a working
converter is refused clearly rather than written into broken hooks/MCP JSON; normal Git Bash
cygpath conversions remain supported.

In Claude's active strict branch, `HARNESS_MCP_COMMAND` is checked before splitting, including its
first word and every argument. A whitespace-only override is invalid. It remains a whitespace word
list, not shell syntax: quotes cannot express a command path containing spaces, and nothing is
re-evaluated with eval. The separate built-in bridge path under Program Files stays one argument.
An override unused by default mode retains its warning-only behavior. JSON-safe runtime dollar,
brace and backtick bytes are data, not new shell source.

Missing validation helpers fail closed. The installer checks required helper availability; this
adds no validation process at runtime.

## Internal re-render transport

Connect's existing Bash child receives renderer path, template, target and raw pairs through a
counted NUL-terminated stdin frame, then sources the same renderer with positional arguments. This
avoids Windows Node→Bash argv splitting of CR/LF; other direct argv callers are unchanged. The Node
encoder refuses embedded NUL. The receiver refuses empty, truncated, count-mismatched or missing
required fields before sourcing the renderer. It is not a shell-command interpreter or a new store.

`render-input-boundaries.test.js`, `runtime-json-input-boundaries.test.js` and `render-frame.test.js`
cover refusal/nonmutation, exact path/record/JSON outcomes, direct argv compatibility and frame
controls with owned executables/homes. These are sealed tests, not a live installer or native
runtime qualification. No registry transaction/locking policy is changed by a rendering refusal.
