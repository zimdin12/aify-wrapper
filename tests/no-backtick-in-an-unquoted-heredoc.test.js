#!/usr/bin/env node
// No unquoted heredoc in this repo's shell sources contains an unescaped backtick.
//
// FOUND IN A CONSUMER, 2026-08-29, which is why this gate is here rather than only there. aify-comms
// writes its environment-bridge launcher with `cat > "$wrapper_path" <<EOF`, and the body carried
// markdown-style prose: `` `aify-comms doctor` reports both the setting ``. Backticks inside an
// unquoted heredoc are command substitution, so every install RAN that command and spliced its stdout
// into the launcher. The shipped file read:
//
//     # collision this tier exists to end.  reports both the setting and whether
//
// A sentence with its subject missing, on the operator's machine, for as long as the line existed.
//
// HARMLESS BY LUCK. `aify-comms doctor` is a read-only verifier. A bare `aify-comms` in the same prose
// starts an environment bridge, superseding the one already serving the host and reaping its managed
// workers -- which is a real incident in that repo, from 2026-08-20, with seven processes killed. It
// also cost time nobody was measuring: two verifier runs per render took one launcher render from
// ~8.5s to ~4.2s once removed.
//
// THIS REPO IS THE AUTHORITATIVE GATE because it owns `wrappers/*.in`. A consumer renders these bytes
// and must ask the same question about its pin and its output, but the source policy lives with the
// source, and the scanner ships in `lib/` so a consumer imports it rather than writing a second one.
//
// WHAT THE RULE IS NOT. It does not prove a heredoc executes nothing: `$(...)` and `$VAR` stay legal
// and executable, because that is how a launcher gets its endpoint baked in. The claim is narrower --
// punctuation cannot silently become a command.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { backticksInUnquotedHeredocs, scanHeredocs } from "../lib/heredoc-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);

/** Every shell source this repo owns, DERIVED. A fifth template is covered the day it lands. */
function shellSources() {
  const files = fs.readdirSync(ROOT)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => path.join(ROOT, name));
  const wrappers = path.join(ROOT, "wrappers");
  for (const name of fs.readdirSync(wrappers)) {
    if (name.endsWith(".in")) files.push(path.join(wrappers, name));
  }
  return files;
}

test("the scan covers every shell source, and finds them by looking", () => {
  // POSITIVE CONTROL on the population. A walk that returned two paths would report this repo clean
  // while never opening the templates, and an unguarded population reports green exactly like a
  // guarded one.
  const found = shellSources().map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
  assert.ok(found.includes("install.sh"), found);
  assert.ok(found.includes("render.sh"), found);
  for (const client of ["claude", "codex", "hermes", "pi"]) {
    assert.ok(found.includes(`wrappers/${client}-aify.sh.in`), `${client} template not scanned: ${found}`);
  }
});

test("THE GATE: no unescaped backtick in any unquoted heredoc", () => {
  for (const file of shellSources()) {
    const name = path.relative(ROOT, file).split(path.sep).join("/");
    const { backticks, unterminated } = scanHeredocs(fs.readFileSync(file, "utf8"));
    assert.deepEqual(unterminated, [], `${name}: a heredoc never ends, so the walk lost the file's `
      + "structure and everything it reported after that point is guesswork");
    assert.deepEqual(
      backticks, [],
      `${name}: a backtick inside an unquoted heredoc runs while the file is WRITTEN, not when it is `
        + "run. Use straight quotes in prose, escape it if the launcher should print one, or write "
        + `$(...) if the substitution is deliberate.\n${JSON.stringify(backticks, null, 2)}`,
    );
  }
});

test("pi's escaped backticks stay legal", () => {
  // The template that would break under a cruder rule. `pi-aify.sh.in` puts escaped backticks inside
  // an unquoted heredoc on purpose, as literal output, and a gate that flagged them would be deleted
  // rather than obeyed.
  const pi = fs.readFileSync(path.join(ROOT, "wrappers", "pi-aify.sh.in"), "utf8");
  assert.ok(pi.includes(BACKSLASH + BACKTICK), "pi no longer contains an escaped backtick, so this "
    + "test proves nothing about the exemption it exists to protect");
  assert.deepEqual(scanHeredocs(pi).backticks, []);
});

test("POSITIVE CONTROL: the scanner can find one", () => {
  const shipped = ['cat > "$path" <<EOF', `# see ${BACKTICK}some command${BACKTICK}`, "EOF"].join(NL);
  const { backticks } = scanHeredocs(shipped);
  assert.equal(backticks.length, 1);
  assert.equal(backticks[0].line, 2);
});

test("MUTANT: an indented terminator is BODY, and the scan must not stop there", () => {
  // The first version of this scanner compared each line with `.trim()`, which is not shell
  // semantics: for a plain `<<EOF` the delimiter must match the whole line. Executed against that
  // version this returned `[]` -- the live backticks below the fake terminator read as script.
  const mutant = ["cat <<EOF", "  EOF", `${BACKTICK}printf danger${BACKTICK}`, "EOF"].join(NL);
  assert.equal(scanHeredocs(mutant).backticks.length, 1);
});

test("MUTANT: `<<-` strips leading TABS only", () => {
  const dashed = ["cat <<-EOF", `${TAB}EOF`, `${BACKTICK}outside${BACKTICK}`].join(NL);
  assert.deepEqual(scanHeredocs(dashed).backticks, [], "a tab-stripped terminator ends a `<<-` heredoc");

  const spaced = ["cat <<-EOF", "  EOF", `${BACKTICK}printf danger${BACKTICK}`, "EOF"].join(NL);
  assert.equal(scanHeredocs(spaced).backticks.length, 1, "spaces never terminate, for either form");
});

test("an unterminated heredoc is a typed failure, not a clean scan", () => {
  const { unterminated } = scanHeredocs(["cat <<EOF", `${BACKTICK}danger${BACKTICK}`].join(NL));
  assert.deepEqual(unterminated, [{ line: 1, delimiter: "EOF" }]);
});

test("NEGATIVE CONTROL: a quoted heredoc and a deliberate $(...) both pass", () => {
  const quoted = ["cat <<'EOF'", `# ${BACKTICK}not a command${BACKTICK}`, "EOF"].join(NL);
  assert.deepEqual(scanHeredocs(quoted).backticks, []);

  const substituted = ["cat <<EOF", 'node $(shell_quote "$script")', "EOF"].join(NL);
  assert.deepEqual(scanHeredocs(substituted).backticks, []);
});

test("backticksInUnquotedHeredocs returns the findings alone", () => {
  // The convenience export, for a caller that has already established the file parses. Exercised
  // against the real module, not a local stand-in: a test that redefines the thing it is covering
  // names an export without touching it, which is precisely what `every-export-is-tested` is
  // generous enough to accept and precisely what makes that generosity worth spending here.
  const source = ["cat <<EOF", `# ${BACKTICK}x${BACKTICK}`, "EOF"].join(NL);
  assert.deepEqual(backticksInUnquotedHeredocs(source), scanHeredocs(source).backticks);
  assert.equal(backticksInUnquotedHeredocs(source).length, 1);
});
