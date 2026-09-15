#!/usr/bin/env node
// render.sh REPLACES a launcher; it never rewrites one in place.
//
// bash reads a script while it runs it, and a launcher is still running for as long as its runtime is: when
// the runtime exits, the launcher reads on from its byte offset. Measured on Windows 2026-09-15: a script
// rewritten in place under a running bash executed the middle of the new file, while a renamed one read on
// in its own text. The reader here is a real bash doing exactly that -- one line, a wait, then the rest.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = path.join(ROOT, "render.sh");
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

function render(out, endpoint) {
  const r = spawnSync("bash", [RENDER, "claude-aify.sh.in", posix(out),
    `ENDPOINT=${endpoint}`, "REGISTRY_FINGERPRINT=fp", "SERVICE_NAME=aify-comms", "WRAPPER_VERSION=0.6.0",
    "NATIVE_BASE=/tmp/base", "SCRIPT_DIR=/tmp/base", "MCP_TRANSPORT=stdio", "BRIDGE_DIR=/tmp/base/mcp/stdio",
    "STRICT_EXTRA_MCP_B64=",
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, `render failed: ${r.stdout}${r.stderr}`);
}

/** A bash holding `file` open after its first line, reading the rest once it is sent a line. */
async function holdOpen(file) {
  const reader = spawn("bash", ["-c", 'exec 3<"$1"; IFS= read -r _ <&3; echo held; IFS= read -r _; cat <&3', "reader", posix(file)]);
  let out = "";
  reader.stdout.on("data", (d) => { out += d; });
  const done = new Promise((resolve) => reader.on("close", resolve));
  const deadline = Date.now() + 30_000;
  while (!out.startsWith("held\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const running = {
    rest: async () => { reader.stdin.end("go\n"); await done; return out.slice("held\n".length); },
    // A failed assertion must not leave this bash holding the test process open: that hung a mutant run.
    kill: () => { if (reader.exitCode === null) reader.kill(); },
  };
  if (out !== "held\n") running.kill();
  assert.equal(out, "held\n", "control: the reader opened the launcher");
  return running;
}

test("a second render puts a NEW file at the launcher's path, and a running launcher reads on in its own text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-rerender-"));
  const out = path.join(dir, "claude-aify");
  render(out, "http://10.20.30.40:1");
  const oldText = fs.readFileSync(out, "utf8");
  const oldId = fs.statSync(out).ino;
  const running = await holdOpen(out);
  try {
    render(out, "http://10.20.30.40:2");
    assert.match(fs.readFileSync(out, "utf8"), /10\.20\.30\.40:2/, "control: the launcher was re-rendered");
    assert.notEqual(fs.statSync(out).ino, oldId, "the launcher was rewritten in place");
    assert.equal(await running.rest(), oldText.slice(oldText.indexOf("\n") + 1), "a running launcher read on into the new file");
    assert.deepEqual(fs.readdirSync(dir), ["claude-aify"], "a staged file was left beside the launcher");
  } finally {
    running.kill();
  }
});

test("control: a file rewritten in place keeps its identity, so the check above can say so", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-inplace-")), "f");
  fs.writeFileSync(file, "one\n");
  const before = fs.statSync(file).ino;
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, "two\n", 0);
  fs.closeSync(fd);
  assert.notEqual(before, 0, "this filesystem reports no file identity");
  assert.equal(fs.statSync(file).ino, before);
});
