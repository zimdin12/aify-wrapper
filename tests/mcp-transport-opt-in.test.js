// The client path can reach MCP over HTTP instead of spawning a local stdio bridge.
//
// A launcher spawning `node <bridge dir>/server.js` is the only reason a host carries a copy of
// aify-comms' own runtime -- 92 MB in ~/.aify-comms. `--mcp-transport http` reaches the service's
// `<endpoint>/mcp/http` instead (claude-aify-adds-the-services-tools-per-launch.test.js runs that arm).
// The deprecated `sse` transport was deleted in aify-comms 0.9.11, with the service's /mcp/sse.
//
// OFF BY DEFAULT. Repointing a live fleet's transport is the operator's call.
//
// The transport is a branch inside the launcher: both arms are present in every launcher and what the
// install decides is which one is LIVE, so asserting a word is absent from a default render tests the
// wrong thing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyRegistry } from "./sealed-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const ENDPOINT = "http://10.20.30.40:8800";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

function render(extraArgs = [], registry = emptyRegistry()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-transport-"));
  const r = spawnSync("bash", [
    INSTALL, "--registry", registry, "--client", "claude", "--endpoint", ENDPOINT, "--render-only", posix(dir), ...extraArgs,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `render failed: ${r.stdout}${r.stderr}`);
  return fs.readFileSync(path.join(dir, "claude-aify"), "utf8");
}

/** Which arm of the transport branch the install made live. */
function liveArm(text) {
  const m = text.match(/^\s*if \[ "([a-z]+)" = "http" \]; then$/m);
  assert.ok(m, "the transport branch is missing from the rendered launcher");
  return m[1] === "http" ? "http" : "stdio";
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

test("--mcp-transport http makes the http arm live", () => {
  assert.equal(liveArm(render(["--mcp-transport", "http"])), "http");
});

for (const transport of ["carrier-pigeon", "sse"]) {
  test(`an unknown transport (${transport}) is refused rather than silently defaulting`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-transport-bad-"));
    const r = spawnSync("bash", [
      INSTALL, "--registry", emptyRegistry(), "--client", "claude", "--endpoint", ENDPOINT, "--render-only", posix(dir),
      "--mcp-transport", transport,
    ], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 78, "a bad transport is a configuration error, not a silent default");
    assert.match(r.stderr, new RegExp(transport), "and it must name what it did not understand");
  });
}

// The guided chain renders with no flag (aify-comms 0.9.11): the service's registry entry decides its launchers.
function declaring(transport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-transport-reg-"));
  const file = path.join(dir, "services.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: ENDPOINT, mcpTransport: transport } } }));
  return posix(file);
}

test("a service that declares http gets http launchers with no flag, and over an explicit stdio", () => {
  assert.equal(liveArm(render([], declaring("http"))), "http");
  assert.equal(liveArm(render(["--mcp-transport", "stdio"], declaring("http"))), "http");
});

test("control: a service that declares stdio keeps stdio, and another service's declaration is not this one's", () => {
  assert.equal(liveArm(render([], declaring("stdio"))), "stdio");
  assert.equal(liveArm(render(["--service", "other-svc"], declaring("http"))), "stdio");
});
