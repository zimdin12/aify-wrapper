#!/usr/bin/env node
// The restore decision, which is the half that can do damage.
//
// THE EXPENSIVE MISTAKE IS NOT A MISSED RESTORE, IT IS A DOUBLE ONE. Relaunching a wrapper into a
// pane that already holds a live agent puts two agents in one pane, both reading the same terminal.
// So `paneIsAnEmptyShell` is the guard this file spends most of its length on, and every one of its
// refusals is driven by ADDING back the sign of life it is supposed to notice.
//
// THE PANE SHAPES ARE REAL. Each fixture below is the shape a live Herdr 0.9.0 returned from
// `herdr pane list` in the measured run: an official-source pane carrying `agent_session` and an
// `agent`, and an aify-source pane carrying a `label` and neither.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { paneLabel } from "../lib/herdr-pane.mjs";
import {
  HerdrPaneLedger,
  LEDGER_VERSION,
  defaultLedgerPath,
  paneIsAnEmptyShell,
  restorePlan,
} from "../lib/herdr-restore.mjs";

const LABEL = paneLabel({ wrapper: "claude-aify", record: "rec1" });

/** An aify pane as it comes back from a restart: label kept, nothing else. */
function restoredAifyPane(overrides = {}) {
  return { pane_id: "w1:p2", label: LABEL, cwd: "C:\\work", ...overrides };
}

/** The official-source pane from the same run, which Herdr resumed itself. */
function nativePane() {
  return {
    pane_id: "w1:p1",
    agent: "claude",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "bogus-session-A" },
  };
}

function ledgerFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-ledger-")), "panes.json");
}

function oneRecord() {
  return new Map([["rec1", { wrapper: "claude-aify", argv: ["claude-aify", "--resume"], cwd: "C:\\work" }]]);
}

test("a restored aify pane with a known record is relaunched with the argv that was recorded", () => {
  const plan = restorePlan({ panes: [restoredAifyPane()], records: oneRecord() });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].paneId, "w1:p2");
  assert.deepEqual(plan[0].argv, ["claude-aify", "--resume"]);
  assert.equal(plan[0].cwd, "C:\\work");
});

test("the pane Herdr resumed itself is left alone", () => {
  // This is the contract half the operator required: bare agents keep native restore, untouched.
  assert.deepEqual(restorePlan({ panes: [nativePane()], records: oneRecord() }), []);
});

test("an occupied pane is refused, proven by adding back each sign of life separately", () => {
  // POSITIVE CONTROL: the empty pane must plan, or the refusals below prove nothing.
  assert.equal(restorePlan({ panes: [restoredAifyPane()], records: oneRecord() }).length, 1);
  const occupied = [
    { agent_session: { source: "herdr:aify", agent: "claude-aify", kind: "id", value: "x" } },
    { agent: "claude-aify" },
  ];
  for (const sign of occupied) {
    const plan = restorePlan({ panes: [restoredAifyPane(sign)], records: oneRecord() });
    assert.deepEqual(plan, [], `a pane carrying ${JSON.stringify(sign)} was relaunched into`);
  }
});

test("an empty agent name does not count as occupied", () => {
  // Herdr reports an absent agent as null; a defensive caller may hand us "". Neither is a live agent.
  assert.equal(paneIsAnEmptyShell({ agent: "", agent_session: null }), true);
  assert.equal(paneIsAnEmptyShell({ agent: null }), true);
  assert.equal(paneIsAnEmptyShell(null), false);
});

test("a pane nobody labelled, and a label with no record, are both left alone", () => {
  const unlabelled = { pane_id: "w1:p5", cwd: "C:\\work" };
  assert.deepEqual(restorePlan({ panes: [unlabelled], records: oneRecord() }), []);
  // A label whose record the ledger has lost: we know it was ours, but not what to run.
  assert.deepEqual(restorePlan({ panes: [restoredAifyPane()], records: new Map() }), []);
});

test("the ledger round-trips through a real file", () => {
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify"], cwd: "C:\\work", workspaceId: "w1" })
    .save();
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.version, LEDGER_VERSION);
  const reloaded = new HerdrPaneLedger({ file }).load();
  assert.equal(reloaded.get("rec1").wrapper, "claude-aify");
  assert.deepEqual(reloaded.get("rec1").argv, ["claude-aify"]);
  assert.equal(reloaded.get("missing"), null);
});

test("a missing or corrupt ledger is empty, never fatal", () => {
  // A wrapper that refused to start because a state file was damaged would be a far worse failure
  // than an agent that does not come back by itself after a reboot.
  const file = ledgerFile();
  assert.equal(new HerdrPaneLedger({ file }).load().all().size, 0);
  fs.writeFileSync(file, "{ this is not json");
  assert.equal(new HerdrPaneLedger({ file }).load().all().size, 0);
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: { bad: { wrapper: "x" } } }));
  // An entry with no argv cannot be replayed, so it is not kept as if it could be.
  assert.equal(new HerdrPaneLedger({ file }).load().all().size, 0);
});

test("a record without the three things a replay needs is refused at write time", () => {
  const ledger = new HerdrPaneLedger({ file: ledgerFile() });
  // Driven by removing each field in turn from an entry that is otherwise complete.
  const complete = { wrapper: "claude-aify", argv: ["claude-aify"], cwd: "C:\\work" };
  ledger.remember("ok", complete);
  for (const field of ["wrapper", "argv", "cwd"]) {
    const broken = { ...complete };
    delete broken[field];
    assert.throws(() => ledger.remember("x", broken), /record needs/, `${field} was dropped and accepted`);
  }
});

test("pruning keeps what live panes still claim and drops the rest", () => {
  const ledger = new HerdrPaneLedger({ file: ledgerFile() });
  ledger.remember("rec1", { wrapper: "claude-aify", argv: ["a"], cwd: "C:\\w" });
  ledger.remember("gone", { wrapper: "hermes-aify", argv: ["b"], cwd: "C:\\w" });
  ledger.pruneTo([LABEL, "somebody-elses-pane", null]);
  assert.deepEqual([...ledger.all().keys()], ["rec1"]);
});

test("the default ledger path sits under the aify home, not in temp", () => {
  const file = defaultLedgerPath({ home: path.join("C:", "Users", "Someone") });
  assert.ok(file.includes(".aify"));
  assert.ok(file.endsWith("panes.json"));
});
