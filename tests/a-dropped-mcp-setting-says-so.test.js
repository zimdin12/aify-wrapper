// A setting the launcher will not apply must not pass silently.
//
// WRAP-M3, external review round 7. `HARNESS_MCP_COMMAND` and `--mcp-transport sse` are read ONLY
// inside the strict-MCP branch, which is opt-in via `AIFY_CLAUDE_STRICT_MCP=1`. In the default mode
// both were dropped with no error, no warning and no effect -- and `--check` printed the configured
// value on its `mcp` line as though it were in force, so the one report an operator consults to find
// out whether their wrapper is configured CONFIRMED a setting the launch then ignored.
//
// The transport is worse than the variable, because of WHO sets it. `--mcp-transport sse` is chosen
// at INSTALL time and baked into the file, so the person who set it is usually not the person
// launching, and nothing connected the two. An operator who installed for sse and then wondered why
// the host still loads a 92 MB bridge copy had nothing to read.
//
// WARNED, NOT APPLIED, and that is the deliberate half. Honouring them in the default mode means
// writing an `--mcp-config`, which IS the strict behaviour this flag exists to opt out of. Changing
// which servers a session sees is a decision; being told a setting was dropped is a repair.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const ENDPOINT = "http://10.20.30.40:8800";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

function render(extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-dropped-"));
  const r = spawnSync("bash", [
    INSTALL, "--client", "claude", "--endpoint", ENDPOINT, "--render-only", posix(dir), ...extraArgs,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `render failed: ${r.stdout}${r.stderr}`);
  return { dir, launcher: path.join(dir, "claude-aify") };
}

/** Run a rendered launcher's `--check` and hand back what it told the operator. */
function check(launcher, env = {}) {
  const r = spawnSync("bash", [launcher, "--check"], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, AIFY_CLAUDE_STRICT_MCP: "", HARNESS_MCP_COMMAND: "", ...env },
  });
  assert.equal(r.status, 0, `--check exited ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

test("--check admits that HARNESS_MCP_COMMAND is not applied in the default mode", () => {
  const { dir, launcher } = render();
  try {
    const out = check(launcher, { HARNESS_MCP_COMMAND: "node /somewhere/other-bridge.js" });
    assert.match(out, /NOT APPLIED/, "--check reported a setting it does not apply as though it did");
    assert.match(out, /HARNESS_MCP_COMMAND/, "--check does not name WHICH setting was dropped");
    assert.match(out, /AIFY_CLAUDE_STRICT_MCP=1/, "--check does not say how to make it apply");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("and that an sse install is not in force either", () => {
  // The half an operator cannot see from their shell: this was decided at install time and baked in.
  const { dir, launcher } = render(["--mcp-transport", "sse"]);
  try {
    const out = check(launcher);
    assert.match(out, /NOT APPLIED/, "an sse-installed launcher claims the transport is in force");
    assert.match(out, /mcp-transport sse/, "--check does not name the transport as the dropped setting");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in strict mode it is applied, and says so instead", () => {
  // CONTRADICTION ARM. Printing "NOT APPLIED" unconditionally would satisfy both tests above and lie
  // in the one configuration where the setting IS honoured.
  const { dir, launcher } = render();
  try {
    const out = check(launcher, {
      AIFY_CLAUDE_STRICT_MCP: "1", HARNESS_MCP_COMMAND: "node /somewhere/other-bridge.js",
    });
    assert.match(out, /strict mode/, "strict mode is not identified");
    assert.doesNotMatch(out, /NOT APPLIED/, "strict mode claims the setting it DOES apply is dropped");
    assert.match(out, /other-bridge\.js/, "strict mode does not show the command it will use");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("and with nothing configured it stays quiet", () => {
  // NEGATIVE CONTROL. A warning that fires for everyone is noise, and noise is how a real one gets
  // scrolled past. The ordinary install must produce no NOT APPLIED line at all.
  const { dir, launcher } = render();
  try {
    const out = check(launcher);
    assert.doesNotMatch(out, /NOT APPLIED/, "an unconfigured launcher warns about settings nobody set");
    assert.match(out, /mcp\s+: <built-in bridge>/, "the ordinary case lost its plain mcp line");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the LAUNCH path warns too, not only --check", () => {
  // STRUCTURAL, AND SAYING SO. The warning this asserts fires on a real launch, which `exec`s claude
  // -- there is no way to observe it here without starting a runtime, and starting one is exactly
  // what these tests must not do. So this checks the branch exists and carries the warning, which
  // catches its removal, and does NOT claim to have watched it print.
  //
  // It matters beyond --check because an operator who never runs --check still gets the drop, and
  // `--mcp-transport sse` was chosen at install time by someone who may not be launching at all.
  const { dir, launcher } = render(["--mcp-transport", "sse"]);
  try {
    const text = fs.readFileSync(launcher, "utf8");
    const strictAt = text.indexOf("--strict-mcp-config");
    assert.ok(strictAt > 0, "the strict branch is missing, so this test is reading the wrong file");
    // The else arm of the strict branch: everything after the flag it adds.
    const afterStrict = text.slice(strictAt);
    assert.match(
      afterStrict, /NOT applied|not applied/,
      "the default-mode branch no longer warns that HARNESS_MCP_COMMAND was dropped, so a launch "
      + "silently ignores it again",
    );
    assert.match(
      afterStrict, /mcp-transport sse|strict MCP mode/,
      "the default-mode branch no longer mentions the sse transport it is declining to use",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
