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

function renderClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-shared-"));
  const result = spawnSync("bash", [
    INSTALL, "--all", "--endpoint", "http://127.0.0.2:1", "--render-only", posix(dir),
  ], { encoding: "utf8", timeout: 180_000 });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(path.join(dir, "claude-aify"), "utf8");
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
