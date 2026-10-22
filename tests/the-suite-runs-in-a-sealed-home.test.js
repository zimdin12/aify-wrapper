#!/usr/bin/env node
// Under `npm test`, nothing a test starts can read or write the operator's home.
//
// The runner (run-in-a-temp-root.mjs) points HOME and USERPROFILE at a fresh directory inside the run's temp root and
// drops the variables the code reads in place of a home default. This checks the effect, not the runner's list: the
// home Node resolves, and every such variable the source reads, scanned from lib/ and bin/. A variable added later
// that still points at the real home turns this red until the runner seals it too.
//
// Run alone with a bare `node --test` this fails, and that is correct: that run does read the real home.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
const inside = (child, parent) => norm(child).startsWith(`${norm(parent)}/`);

/** Every `env.NAME` / `process.env.NAME` the JS source reads whose name says it locates state. */
function stateVariablesReadBySource() {
  const names = new Set();
  for (const dir of ["lib", "bin"]) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/\.m?js$/.test(file)) continue;
      const text = fs.readFileSync(path.join(ROOT, dir, file), "utf8");
      for (const m of text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*(?:_DIR|_HOME|_REGISTRY|_LEDGER))\b/g)) names.add(m[1]);
    }
  }
  return names;
}

test("the probe's own parts: inside() says no to a sibling with a shared prefix, and the scan finds known readers", () => {
  assert.equal(inside("/a/bc/x", "/a/b"), false);
  assert.equal(inside("/a/b/x", "/a/b"), true);
  const names = stateVariablesReadBySource();
  for (const known of ["CLAUDE_CONFIG_DIR", "HERMES_HOME", "AIFY_SERVICE_REGISTRY", "AIFY_AGENT_LEASE_DIR"]) {
    assert.ok(names.has(known), `the scan missed ${known}, so it cannot vouch for the rest: ${[...names].join(", ")}`);
  }
});

test("the home every test and child resolves is a fresh directory inside this run's temp root", () => {
  const home = os.homedir();
  assert.ok(inside(home, os.tmpdir()), `os.homedir() is ${home}, outside the run's temp root ${os.tmpdir()}: the real home`);
  assert.equal(norm(process.env.HOME || ""), norm(home), "HOME, which git-bash children read, is not the sealed home");
  if (process.platform === "win32") assert.equal(norm(process.env.USERPROFILE || ""), norm(home));
  assert.ok(!fs.existsSync(path.join(home, ".aify", "services.json")), "the sealed home already holds a registry");
});

test("no variable the code reads in place of a home default points outside the run's temp root", () => {
  const escaped = [...stateVariablesReadBySource()]
    .filter((name) => process.env[name] && !inside(process.env[name], os.tmpdir()))
    .map((name) => `${name}=${process.env[name]}`);
  assert.deepEqual(escaped, [], "seal these in tests/run-in-a-temp-root.mjs");
});
