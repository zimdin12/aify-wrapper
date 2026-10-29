#!/usr/bin/env node
// Under `npm test`, nothing a test starts can read or write the operator's home.
//
// The runner (run-in-a-temp-root.mjs) points HOME and USERPROFILE at a fresh directory inside the run's temp root and
// drops the variables the code reads in place of a home default. This checks the effect, not the runner's list: the
// home Node resolves, hermes' roots as the installer joins them, an override inherited in any spelling as a child's
// reader sees it, and every variable the immediate lib/ and bin/ JS reads as a state location. A variable added later
// that still points at the real home turns this red until the runner seals it too.
//
// Run alone with a bare `node --test` this fails, and that is correct: that run does read the real home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hermesRoots } from "../lib/hermes-config-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "tests", "run-in-a-temp-root.mjs");
const PROBE = "tests/fixtures/sealed-home-probe.test.js";
const HERMES_CLI = path.join(ROOT, "lib", "hermes-config-cli.mjs");
const FAKE_HERMES = path.join(ROOT, "tests", "fake-hermes.mjs");
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
  if (process.platform === "win32") {
    assert.equal(norm(process.env.USERPROFILE || ""), norm(home));
    for (const name of ["LOCALAPPDATA", "APPDATA"]) {
      assert.ok(inside(process.env[name] || "", os.tmpdir()), `${name} is ${process.env[name]}, outside the run's temp root`);
    }
  }
  assert.ok(!fs.existsSync(path.join(home, ".aify", "services.json")), "the sealed home already holds a registry");
});

test("hermes' install-state roots, joined as the installer's update check joins them, are inside the run's temp root", () => {
  const roots = hermesRoots({ env: process.env, platform: process.platform, homedir: os.homedir(), join: path.join, dirname: path.dirname, basename: path.basename });
  assert.ok(roots.length > 0);
  assert.deepEqual(roots.filter((root) => !inside(root, os.tmpdir())), [], "a hermes root outside the run: the operator's own");
});

test("the installer's hermes step reads the private roots clean, and sees an external pending update only when pointed at it", () => {
  // The CLI end to end, against the stand-in hermes. The external root is this test's own directory, never the
  // operator's: pointing the native base at it is the control that the step does read a marker there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-hermes-"));
  try {
    const registry = path.join(dir, "services.json");
    fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-dashboard": {
      endpoint: "http://127.0.0.2:9700", sessionInject: { mcp: true }, mcp: [{ name: "aify-dashboard", command: "node", args: ["/d/bridge.mjs"] }],
    } } }));
    const external = path.join(dir, "external");
    const nativeBase = process.platform === "win32" ? "LOCALAPPDATA" : "HOME";
    const marker = path.join(external, process.platform === "win32" ? "hermes" : ".hermes", "installs", "0123456789abcdef", "source-completion-pending");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "an update that never finished\n");
    const run = (extra) => {
      const state = path.join(dir, "state.json");
      fs.writeFileSync(state, "{}");
      const env = { ...process.env, HERMES_RUNTIME_COMMAND: FAKE_HERMES, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: path.join(dir, "calls.log"), ...extra };
      return spawnSync(process.execPath, [HERMES_CLI, "--write-now", registry], { encoding: "utf8", env, timeout: 60_000 });
    };
    const clean = run({});
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /wrote aify-dashboard/);
    const pointed = run({ [nativeBase]: external });
    assert.equal(pointed.status, 78, `the control did not see the external marker: ${pointed.stdout}${pointed.stderr}`);
    assert.ok(pointed.stderr.includes("source-completion-pending"), pointed.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The probe run as a child, under the runner or directly, with `extra` added to this process's environment. */
function probe(extra, { viaRunner }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-probe-"));
  try {
    const out = path.join(dir, "out.json");
    const env = { ...process.env, SEALED_HOME_PROBE_OUT: out };
    // NODE_TEST_CONTEXT is how this test run tells its children they are its subtests; a nested run that keeps it
    // reports to this one and never runs the probe.
    for (const name of Object.keys(env)) if (/^(CLAUDE_CONFIG_DIR|AIFY_SERVICE_REGISTRY|NODE_TEST_CONTEXT)$/i.test(name)) delete env[name];
    Object.assign(env, extra);
    const argv = viaRunner ? [RUNNER, PROBE] : ["--test", PROBE];
    const run = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8", env, timeout: 120_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return JSON.parse(fs.readFileSync(out, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [spelling, names] of [
  ["mixed-case", ["Claude_Config_Dir", "Aify_Service_Registry"]],
  ["uppercase", ["CLAUDE_CONFIG_DIR", "AIFY_SERVICE_REGISTRY"]],
  ["absent", []],
]) {
  const caseInsensitiveOnly = spelling === "mixed-case" && process.platform !== "win32";
  test(`an inherited ${spelling} override never reaches a child's reader`, { skip: caseInsensitiveOnly && "names are case-sensitive here, so a mixed-case name is not an override" }, () => {
    const external = path.join(os.tmpdir(), `external-${spelling}`);
    const extra = names.length ? { [names[0]]: external, [names[1]]: path.join(external, "services.json") } : {};
    const leaked = (seen) => [seen.claudeUserSettings, seen.registry].filter((p) => p && (inside(p, external) || norm(p) === norm(external)));
    if (names.length) {
      // The control: run directly, the same child's reader does take the override.
      const direct = probe(extra, { viaRunner: false });
      assert.equal(leaked(direct).length, 2, `the probe cannot see this override, so it cannot vouch for the runner: ${JSON.stringify(direct)}`);
    }
    const sealed = probe(extra, { viaRunner: true });
    assert.deepEqual(leaked(sealed), [], `the runner passed an override through: ${JSON.stringify(sealed)}`);
    assert.equal(sealed.registry, null);
    assert.ok(inside(sealed.claudeUserSettings, os.tmpdir()), sealed.claudeUserSettings);
  });
}

test("no variable the code reads in place of a home default points outside the run's temp root", () => {
  const escaped = [...stateVariablesReadBySource()]
    .filter((name) => process.env[name] && !inside(process.env[name], os.tmpdir()))
    .map((name) => `${name}=${process.env[name]}`);
  assert.deepEqual(escaped, [], "seal these in tests/run-in-a-temp-root.mjs");
});
