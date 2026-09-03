// `claude-aify --shared`: the host tier owns the session, so closing the window does not end it.
//
// v0.6.2's headline. Today a resident agent is a child of the operator's shell and dies with it;
// with the flag, aify-env runs it, the terminal is attached rather than owning it, and detaching
// leaves the agent working.
//
// IT RE-RUNS THIS WRAPPER rather than building a command for the host. Every wrapper does real work
// before it launches -- resolving the runtime, composing MCP flags, reaping a prior session -- and a
// rebuilt command line would reproduce whichever parts somebody remembered. Re-running the wrapper
// reproduces all of them by construction, including whatever is added next year. It also passes
// aify-env's launcher allowlist by being a wrapper, which is exactly what that allowlist is for.
//
// THE DEFAULT PATH IS UNTOUCHED, and that is the operator's constraint on the whole feature rather
// than a nicety. Most of this file is therefore about what an ORDINARY run still does: the branch is
// below everything, so a normal `claude-aify` reaches the runtime having executed not one
// instruction of it.
//
// RENDERED AND READ, not reasoned about. These assert on the launcher `install.sh --render-only`
// actually produces, because the template is a template: a change that looks right in the `.sh.in`
// and does not survive substitution is the failure this repo's determinism tests exist for.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

/** Every launcher this repo renders, by name. DERIVED from the templates rather than listed, so a
 *  fifth wrapper is covered on the day it lands instead of quietly escaping this whole file. */
const LAUNCHERS = fs.readdirSync(path.join(ROOT, "wrappers"))
  .filter((name) => name.endsWith("-aify.sh.in"))
  .map((name) => name.replace(".sh.in", ""))
  .sort();

let RENDERED = null;
function renderAll() {
  if (RENDERED) return RENDERED;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-shared-"));
  const result = spawnSync("bash", [
    INSTALL, "--all", "--endpoint", "http://127.0.0.2:1", "--render-only", posix(dir),
  ], { encoding: "utf8", timeout: 180_000 });
  assert.equal(result.status, 0, result.stderr);
  // ONLY WHAT WAS ACTUALLY WRITTEN. `--all` does not render every template: pi installs are
  // deliberately disabled, so `pi-aify.sh.in` exists and produces no launcher. Reading the template
  // list and assuming a file made every assertion below fail with ENOENT on a repo behaving
  // correctly -- and the test that NAMES the gap is below, so a template that stops rendering for a
  // NEW reason is visible rather than quietly skipped.
  RENDERED = Object.fromEntries(
    LAUNCHERS
      .filter((name) => fs.existsSync(path.join(dir, name)))
      .map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]),
  );
  return RENDERED;
}

function renderClaude() {
  return renderAll()["claude-aify"];
}

/** Executable lines only: this feature is heavily commented, and a comment is not wiring. */
const code = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("THE DEFAULT PATH STILL ENDS EXACTLY AS IT DID", () => {
  // The operator's constraint. If this line ever changes shape, an ordinary resident session is no
  // longer what it was, whatever the flag does.
  const claude = renderClaude();
  assert.match(
    claude,
    /\nclaude --dangerously-load-development-channels server:aify-comms-channel "\$\{CLAUDE_MCP_FLAGS\[@\]\}" "\$\{CLAUDE_PERMISSION_FLAGS\[@\]\}" "\$\{CLAUDE_ARGS\[@\]\}"\nSTATUS=\$\?\nexit "\$STATUS"/,
    "the ordinary launch line changed shape",
  );
});

test("the shared branch sits BELOW everything, so a normal run never enters it", () => {
  // Placement is the whole safety argument: an ordinary run executes not one instruction of this
  // feature. Asserted by position rather than by reading, because "below everything" is the property.
  const lines = code(renderClaude()).split("\n");
  const branch = lines.findIndex((l) => l.includes("CLAUDE_AIFY_SHARED") && l.includes("if"));
  const launch = lines.findIndex((l) => l.startsWith("claude --dangerously-load"));
  assert.ok(branch > 0, "no shared branch in the rendered launcher");
  assert.ok(branch < launch, "the branch is below the launch line, so --shared would never fire");
  // And nothing between them: the branch execs or falls through, and any work in the gap would run
  // on the ordinary path too.
  const between = lines.slice(branch, launch).filter((l) => l.trim() && !l.trim().startsWith("fi"));
  assert.ok(between.length < 14, `the shared branch grew to ${between.length} lines before the launch`);
});

test("IT ASKS THE HOST TO RUN THIS WRAPPER, not a rebuilt command", () => {
  const claude = code(renderClaude());
  assert.match(claude, /exec aify-env run/, "the branch does not hand the session to the host tier");
  assert.match(claude, /--launcher "\$0"/,
    "the request names something other than this wrapper, so what runs is a guess at what would have");
  assert.match(claude, /--service "aify-comms"/, "the service is not carried, and the host requires an owner");
});

test("the flag is stripped from what the host re-runs", () => {
  // Left in, the relaunched wrapper asks the host to start a wrapper that asks the host to start a
  // wrapper. The passthrough is built by filtering the ORIGINAL arguments once, not inside the parse
  // loop -- that loop has a dozen branches and the one added next year is the one that would forget.
  const claude = code(renderClaude());
  assert.match(claude, /for _ORIGINAL in "\$@"; do/, "the passthrough is not built from the original argv");
  assert.match(claude, /\[ "\$_ORIGINAL" = "--shared" \] \|\| CLAUDE_AIFY_PASSTHRU\+=\("\$_ORIGINAL"\)/);
  assert.match(claude, /-- "\$\{CLAUDE_AIFY_PASSTHRU\[@\]\}"/, "the host is handed something other than the original args");
});

test("EXACTLY --shared, so a neighbouring flag is somebody else's", () => {
  // A prefix test would swallow `--shared-memory` and host a session nobody asked to host, while
  // also dropping an argument the runtime needed.
  const claude = code(renderClaude());
  assert.match(claude, /if \[ "\$ARG" = "--shared" \]; then/,
    "the flag is matched loosely, so a neighbouring flag would trigger it");
});

test("a missing aify-env is REFUSED, not silently ignored", () => {
  // Falling through to an ordinary start would be the worst outcome: the operator asked for a
  // session that survives their terminal, got one that does not, and nothing said so.
  const claude = code(renderClaude());
  assert.match(claude, /command -v aify-env/, "nothing checks that the host tier is present");
  assert.match(claude, /exit 69/, "a missing host tier does not fail the run");
});

test("the shared branch names no runtime of its own", () => {
  // The other three wrappers get this same wiring, and it must be copyable without edits: the
  // template's own substitutions carry the service, and `$0` carries the launcher.
  const claude = renderClaude();
  const start = claude.indexOf("CLAUDE_AIFY_SHARED\" = true");
  const branch = claude.slice(start, claude.indexOf("\nclaude --dangerously", start));
  assert.ok(!/\bclaude\b/.test(code(branch)),
    "the shared branch names claude, so it cannot be copied to the other three wrappers as-is");
});

// ── and the same wiring in all four ──────────────────────────────────────────────────────────────
//
// The block was written to be copyable -- it names no runtime and uses `${0##*/}` for its own name --
// so the other three wrappers get it unedited. These assert that they DID, because "copyable" is
// worth nothing if three copies drifted the moment they were made.

test("EVERY LAUNCHER OFFERS --shared", () => {
  const rendered = renderAll();
  assert.ok(LAUNCHERS.length >= 4, `only ${LAUNCHERS.length} launcher(s) found; the scan is not reaching them`);
  for (const [name, text] of Object.entries(rendered)) {
    assert.match(code(text), /exec aify-env run/, `${name} cannot hand its session to the host tier`);
  }
});

test("THE PASSTHROUGH IS EXPANDED, not named", () => {
  // THE BUG THIS CAUGHT, and it is why this test exists rather than a comment. Generating the block
  // for three templates left `"$CODEX_PASSTHRU_EXPANSION"` -- a variable that does not exist. Bash
  // accepts it, `bash -n` passes, and the relaunched wrapper would have received ONE EMPTY ARGUMENT
  // instead of everything the operator typed. A wrong expansion is silent in exactly the way a
  // missing one is not.
  for (const [name, text] of Object.entries(renderAll())) {
    const exec = code(text).split("\n").find((line) => line.includes("exec aify-env run"));
    assert.ok(exec, `${name} has no exec line`);
    assert.match(exec, /-- "\$\{[A-Z]+_AIFY_PASSTHRU\[@\]\}"$/,
      `${name} passes something other than its own expanded passthrough array: ${exec}`);
  }
});

test("each launcher carries its OWN prefix, not a copied one", () => {
  // The other half of copyable: a block pasted without renaming its variables reads the wrong array,
  // which is empty -- the same silent argument loss by a different route.
  for (const [name, text] of Object.entries(renderAll())) {
    const prefix = { "claude-aify": "CLAUDE", "codex-aify": "CODEX", "hermes-aify": "HERMES", "pi-aify": "PI" }[name];
    if (!prefix) continue;
    assert.match(code(text), new RegExp(`${prefix}_AIFY_SHARED=false`), `${name} lost its own flag variable`);
    assert.match(code(text), new RegExp(`${prefix}_AIFY_PASSTHRU\+=`), `${name} lost its own passthrough`);
    // AND THE BRANCH IS REACHABLE. Asserting the exec line exists says nothing about whether it can
    // run: replacing the condition with `if false` leaves the line in place and every other
    // assertion here green -- measured, and it is the "a guard that cannot fire is decoration" shape
    // this project keeps finding. The condition must read this launcher's OWN flag.
    assert.ok(code(text).includes(`if [ "$${prefix}_AIFY_SHARED" = true ]; then`),
      `${name}'s shared branch is not gated on its own flag, so it either never fires or always does`);
  }
});

test("no launcher names another launcher's runtime in the block", () => {
  // A message hardcoding one name is how a copy starts lying about itself: `codex-aify` announcing
  // that "claude-aify needs aify-env on PATH" sends the reader to the wrong file.
  for (const [name, text] of Object.entries(renderAll())) {
    const start = text.indexOf("_AIFY_SHARED\" = true");
    if (start < 0) continue;
    const block = code(text.slice(start, start + 900));
    for (const other of ["claude-aify", "codex-aify", "hermes-aify", "pi-aify"]) {
      if (other === name) continue;
      assert.ok(!block.includes(other), `${name}'s shared block names ${other}`);
    }
  }
});

test("a template that renders NOTHING is named, not skipped", () => {
  // `--all` renders three of four: pi is disabled on purpose (OMP is single-client, so there is no
  // resident wake to provide). Recorded as an assertion so the day a SECOND template stops rendering
  // -- for a reason nobody chose -- this file says so instead of quietly testing one launcher less.
  const missing = LAUNCHERS.filter((name) => !(name in renderAll()));
  assert.deepEqual(missing, ["pi-aify"],
    "the set of templates that render nothing changed; if that is deliberate, say why here");
});
