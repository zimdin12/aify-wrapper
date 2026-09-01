// The client path can reach MCP over HTTP instead of spawning a local stdio bridge.
//
// A launcher spawning `node <bridge dir>/server.js` is the only reason a host carries a copy of
// aify-comms' own runtime -- 92 MB in ~/.aify-comms. The container serves the same MCP at
// `<endpoint>/mcp/sse`, so a launcher pointed there needs no service code on the host. That is the
// difference between the two install paths in aify-comms' docs/TARGET_ARCHITECTURE.md being real or
// notional.
//
// OFF BY DEFAULT. Repointing a live fleet's transport is the operator's call.
//
// The endpoint resolves at RUNTIME -- HARNESS_ENDPOINT can be overridden per launch -- so the
// transport is a branch inside the launcher, not a string chosen at render time. Both arms are
// therefore present in every launcher and what the install decides is which one is LIVE. Asserting
// that the word "sse" is absent from a default render tests the wrong thing, which is what the first
// version of these tests did.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sse-"));
  const r = spawnSync("bash", [
    INSTALL, "--client", "claude", "--endpoint", ENDPOINT, "--render-only", posix(dir), ...extraArgs,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `render failed: ${r.stdout}${r.stderr}`);
  return fs.readFileSync(path.join(dir, "claude-aify"), "utf8");
}

/** Which arm of the transport branch the install made live. */
function liveArm(text) {
  const m = text.match(/^\s*if \[ "([a-z]+)" = "sse" \]; then$/m);
  assert.ok(m, "the transport branch is missing from the rendered launcher");
  return m[1] === "sse" ? "sse" : "stdio";
}

test("by default the launcher still spawns the local stdio bridge", () => {
  const text = render();
  assert.equal(liveArm(text), "stdio");
  // THE LAYOUT IS NO LONGER SPELLED AT THIS SITE. The `mcp/stdio` segment moved into the installed
  // bridge directory the launcher derives once, so only the entry-point FILE is named here. This
  // used to assert the concatenated `mcp/stdio/server.js`, which is exactly the coupling row 5
  // removes -- re-asserting it would pin the launcher to aify-comms' internal layout, which is the
  // thing that stopped a second service being able to use this launcher at all.
  //
  // The intent is unchanged and is now checked in two parts, because one alone would pass on a
  // launcher that had lost the other half.
  assert.match(text, /\$\{AIFY_BRIDGE_DIR_FWD\}\/server\.js/,
    "the stdio arm must still name the local bridge entry point");
  assert.match(text, /AIFY_BRIDGE_DIR_FWD=.*mcp\/stdio/,
    "and that directory must still resolve to the host's own copy of the bridge");
});

test("the default render is byte-identical to one with the flag explicitly off", () => {
  // Naming the default must not perturb it.
  assert.equal(render(), render(["--mcp-transport", "stdio"]));
});

test("--mcp-transport sse points the launcher at the container", () => {
  const text = render(["--mcp-transport", "sse"]);
  assert.equal(liveArm(text), "sse");
  // Built from the RESOLVED endpoint at launch rather than baked, so a per-launch override still
  // reaches the right service. Baking it is the bug this pattern replaced in strict mode, where the
  // wrapper announced one endpoint and its bridge talked to another.
  assert.match(text, /\$\{HARNESS_ENDPOINT\}\/mcp\/sse/, "the sse arm must use the resolved endpoint");
});

test("an unknown transport is refused rather than silently defaulting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sse-bad-"));
  const r = spawnSync("bash", [
    INSTALL, "--client", "claude", "--endpoint", ENDPOINT, "--render-only", posix(dir),
    "--mcp-transport", "carrier-pigeon",
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 78, "a bad transport is a configuration error, not a silent default");
  assert.match(r.stderr, /carrier-pigeon/, "and it must name what it did not understand");
});
