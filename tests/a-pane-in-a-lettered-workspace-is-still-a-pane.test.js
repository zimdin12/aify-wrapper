#!/usr/bin/env node
// Herdr numbers its tenth workspace `wA`, and the ones after with letters too (live 2026-10-03: wA, wC-wF,
// wJ). Both of our pane checks took digits only. The claim refused such a pane as "not running in a herdr
// pane", so the agent was never claimed and Herdr later resumed it bare (golf-manager in `wA:p1`), and the
// state hook dropped every report, so managed panes from `wA` on showed no status dot.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { readPaneContext } from "../lib/herdr-pane.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_SCRIPT = path.join(ROOT, "bin", "aify-herdr-state.sh").replace(/\\/g, "/");

const paneEnv = (overrides = {}) => ({
  HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t2", HERDR_WORKSPACE_ID: "w1",
  HERDR_BIN_PATH: "C:/herdr/herdr.exe", ...overrides,
});

test("a pane in a lettered workspace is a pane to claim", () => {
  const context = readPaneContext(paneEnv({ HERDR_PANE_ID: "wA:p1", HERDR_TAB_ID: "wA:t1", HERDR_WORKSPACE_ID: "wA" }));
  assert.ok(context, "wA:p1 was refused as not a herdr pane");
  assert.equal(context.paneId, "wA:p1");
  // The rest of the grammar still refuses: a tab id as a pane, and a separator inside an id.
  assert.equal(readPaneContext(paneEnv({ HERDR_PANE_ID: "wA:t1" })), null);
  assert.equal(readPaneContext(paneEnv({ HERDR_PANE_ID: "wA:p1;x" })), null);
});

/** What the state hook asks Herdr for, given the pane it reads. */
function reportsFor(pane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lettered-")).replace(/\\/g, "/");
  const log = `${dir}/reports.log`;
  fs.writeFileSync(`${dir}/herdr`, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  const result = spawnSync("sh", [STATE_SCRIPT, "idle"], {
    input: "", encoding: "utf8",
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: dir, HERDR_BIN_PATH: `${dir}/herdr`,
      AIFY_HERDR_AGENT: "claude-aify", AIFY_HERDR_PANE_ID: pane, AIFY_HOOK_FIRED_AT: "1790000000.000001" },
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("the state hook reports a pane in a lettered workspace", () => {
  assert.deepEqual(reportsFor("w1:p2").length, 1, "control: a digits-only pane reports");
  const [line] = reportsFor("wA:p1");
  assert.match(line ?? "", /^pane report-agent wA:p1 --source herdr:aify --agent claude-aify --state idle /);
});

test("the state hook still sends nothing for what is not a pane id", () => {
  for (const pane of ["", "p2", "wA:t1", "wA:p1 x", "w1:p2 x", "wA:p1:p2", "w:p1", "wA:p"]) {
    assert.deepEqual(reportsFor(pane), [], `reported for ${JSON.stringify(pane)}`);
  }
});
