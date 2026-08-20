#!/usr/bin/env node
// The staleness check, run the way somebody runs it.
//
// The verdict logic is unit-tested next door. What is only reachable here is the wiring, and one
// property that is easy to lose in a refactor: THIS MUST NOT EXECUTE A LAUNCHER. A launcher built
// before the harness contract does not know `--check` and forwards it to the runtime, so a checker
// that asks instead of reads starts an agent — which is how a four-second probe once superseded a live
// environment bridge and reaped a managed fleet.
//
// So one test plants a launcher that would leave a sentinel file if it ever ran, and requires the
// sentinel not to exist afterwards.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "..", "bin", "aify-wrapper-check.mjs");
const INSTALL = path.join(HERE, "..", "install.sh");
const NOWHERE = "http://127.0.0.2:1";

const registryFor = (services) => JSON.stringify({ version: 1, services });

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-check-"));
  const dest = path.join(dir, "bin");
  // Explicit rather than using mkdirSync's return value, which is the first directory it CREATED and
  // is undefined when the path already exists -- a cleverness that silently pointed this whole file at
  // the wrong directory and reported "no launchers found" for every case.
  fs.mkdirSync(dest, { recursive: true });
  return {
    dir,
    dest,
    registry: path.join(dir, "services.json"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const runCheck = (w, extra = []) => spawnSync(
  process.execPath,
  [CHECK, "--dest", w.dest, "--registry", w.registry, "--json", ...extra],
  { encoding: "utf8", timeout: 60_000 },
);

/** Render a real launcher against a given registry, which is what makes this end to end. */
function install(w, registryJson) {
  fs.writeFileSync(w.registry, registryJson);
  const res = spawnSync("bash", [
    INSTALL, "--client", "claude", "--endpoint", NOWHERE,
    "--render-only", w.dest, "--registry", w.registry,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
}

test("a launcher installed against the CURRENT registry reads as current", () => {
  const w = workspace();
  try {
    install(w, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));
    const report = JSON.parse(runCheck(w).stdout);
    assert.equal(report.ok, true, report.summary);
    assert.deepEqual(report.current.map((r) => r.name), ["claude-aify"]);
  } finally {
    w.cleanup();
  }
});

test("registering another service afterwards makes the launcher STALE", () => {
  // The case the fingerprint exists for, end to end: install, then the world changes underneath.
  const w = workspace();
  try {
    install(w, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));
    fs.writeFileSync(w.registry, registryFor({
      "aify-comms": { endpoint: NOWHERE, mcp: [] },
      "aify-graph": { endpoint: "http://127.0.0.2:2", mcp: [] },
    }));

    const report = JSON.parse(runCheck(w).stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.stale.map((r) => r.name), ["claude-aify"]);
    assert.notEqual(report.stale[0].installed, report.stale[0].expected);
    assert.match(report.summary, /reinstall/i);
  } finally {
    w.cleanup();
  }
});

test("--strict exits 1 on a stale launcher, and 0 when everything is current", () => {
  const w = workspace();
  try {
    install(w, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));
    assert.equal(runCheck(w, ["--strict"]).status, 0);

    fs.writeFileSync(w.registry, registryFor({ other: { endpoint: NOWHERE, mcp: [] } }));
    assert.equal(runCheck(w, ["--strict"]).status, 1);
  } finally {
    w.cleanup();
  }
});

test("IT DOES NOT EXECUTE THE LAUNCHER", () => {
  // The property worth a test of its own. A pre-contract wrapper forwards --check to the runtime, so a
  // checker that asks instead of reads starts an agent.
  const w = workspace();
  try {
    const sentinel = path.join(w.dir, "IT-RAN");
    fs.writeFileSync(path.join(w.dest, "trap-aify"), [
      "#!/bin/bash",
      `touch "${sentinel.split(String.fromCharCode(92)).join("/")}"`,
      'HARNESS_REGISTRY_FINGERPRINT="whatever"',
      "",
    ].join(String.fromCharCode(10)));
    fs.chmodSync(path.join(w.dest, "trap-aify"), 0o755);
    fs.writeFileSync(w.registry, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));

    runCheck(w);
    assert.equal(fs.existsSync(sentinel), false, "the checker executed a launcher");
  } finally {
    w.cleanup();
  }
});

test("a host with NO launchers is not reported as fine", () => {
  // Nothing installed means nothing verified, and this family of checks exists to stop that reading as
  // a pass.
  const w = workspace();
  try {
    fs.writeFileSync(w.registry, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));
    const report = JSON.parse(runCheck(w).stdout);
    assert.equal(report.ok, false);
    assert.match(report.summary, /no launchers/i);
  } finally {
    w.cleanup();
  }
});

test("a launcher with no fingerprint is UNREADABLE, not current", () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dest, "old-aify"), '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.5.7"\n');
    fs.writeFileSync(w.registry, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));
    const report = JSON.parse(runCheck(w).stdout);
    assert.deepEqual(report.unknown.map((r) => r.name), ["old-aify"]);
    assert.equal(report.ok, false);
  } finally {
    w.cleanup();
  }
});

test("an UNUSABLE registry refuses rather than calling every launcher stale", () => {
  // Comparing against a guess would blame the launchers and hide the real problem, which is the file.
  const w = workspace();
  try {
    install(w, registryFor({ "aify-comms": { endpoint: NOWHERE, mcp: [] } }));
    fs.writeFileSync(w.registry, "{not json");
    const res = runCheck(w, ["--strict"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /registry/i);
    assert.doesNotMatch(res.stdout, /STALE/, "it blamed the launchers for a broken registry");
  } finally {
    w.cleanup();
  }
});

test("POSITIVE CONTROL: it finds the launchers on the REAL install directory", () => {
  // Every case above plants files in a temp directory. If the discovery glob stopped matching what an
  // install actually produces, all of them would still pass while the check found nothing on any real
  // host. Read-only: it lists and reads, and the previous test proves it never executes.
  const realDest = path.join(os.homedir(), ".local", "bin");
  if (!fs.existsSync(realDest)) {
    assert.fail(`${realDest} does not exist, so the discovery glob cannot be controlled here`);
  }
  const found = fs.readdirSync(realDest).filter((n) => /-aify$/.test(n));
  assert.ok(found.length > 0, `no launchers found in ${realDest}; the glob may no longer match`);
  const res = spawnSync(process.execPath, [CHECK, "--dest", realDest, "--registry", path.join(os.tmpdir(), "no-such-registry.json"), "--json"], {
    encoding: "utf8", timeout: 60_000,
  });
  const report = JSON.parse(res.stdout);
  const seen = [...report.current, ...report.stale, ...report.unknown].map((r) => r.name);
  for (const name of found) assert.ok(seen.includes(name), `${name} was not examined`);
});
