#!/usr/bin/env node
// The agent's state hooks run in the background, so two reports can finish out of order: an `idle` that
// lands before its turn's last `working` would leave the pane reading working. bin/aify-herdr-state.sh
// carries when each hook fired and keeps the latest. These run the real script through `sh` against a
// stub `herdr` that records what it was asked, which also runs on Windows (the shell runs the stub).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_SCRIPT = path.join(ROOT, "bin", "aify-herdr-state.sh").replace(/\\/g, "/");

function pane({ duringReport = () => "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-order-")).replace(/\\/g, "/");
  const log = `${dir}/reports.log`;
  const herdr = `${dir}/herdr`;
  const cache = `${dir}/aify-herdr-w1-p2.state`;
  // `duringReport` runs inside the stub's report call: it stands in for a later hook finishing first.
  fs.writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${duringReport(cache)}\nexit 0\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: dir, HERDR_BIN_PATH: herdr,
    AIFY_HERDR_AGENT: "claude-aify", AIFY_HERDR_PANE_ID: "w1:p2", AIFY_HERDR_LAUNCH: "42",
  };
  const report = (state, firedAt) => {
    const result = spawnSync("sh", [STATE_SCRIPT, state], { input: "", encoding: "utf8", env: { ...env, AIFY_HOOK_FIRED_AT: firedAt } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  };
  const states = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((line) => line.split(" --state ")[1]);
  return { report, states, cache };
}

test("a report older than the last one is dropped", () => {
  const { report, states } = pane();
  report("idle", "1790000000.000002");
  report("working", "1790000000.000001");
  assert.deepEqual(states(), ["idle"]);
});

test("CONTROL: reports in the order they fired all land", () => {
  const { report, states } = pane();
  report("working", "1790000000.000001");
  report("idle", "1790000000.000002");
  assert.deepEqual(states(), ["working", "idle"]);
});

test("a locale comma in the fired time orders the same as a point", () => {
  const { report, states } = pane();
  report("idle", "1790000000,000002");
  report("working", "1790000000,000001");
  assert.deepEqual(states(), ["idle"]);
});

test("a report that finishes after a later one re-sends the later state", () => {
  const cacheLine = "42 idle 1790000000000002";
  const { report, states, cache } = pane({ duringReport: (file) => `printf '%s' '${cacheLine}' > '${file}'` });
  report("working", "1790000000.000001");
  assert.deepEqual(states(), ["working", "idle"], "the earlier working was left standing over the later idle");
  assert.equal(fs.readFileSync(cache, "utf8"), cacheLine, "the later report's record was overwritten by the earlier one");
});

test("CONTROL: with no later report in between, the report is recorded as the latest", () => {
  const { report, states, cache } = pane();
  report("working", "1790000000.000001");
  assert.deepEqual(states(), ["working"]);
  assert.equal(fs.readFileSync(cache, "utf8"), "42 working 1790000000000001");
});
