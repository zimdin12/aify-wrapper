#!/usr/bin/env node
// The restore decision and the ledger, which are the two places this feature can do damage.
//
// THE EXPENSIVE MISTAKE IS NOT A MISSED RESTORE. It is relaunching a wrapper into a pane that
// already has one running, and DELETING the records that say how to restore anything. Review found
// both, and each fix below is pinned by a test that fails without it:
//
//   - A live handoff keeps the PTYs but gives the new server no agent report, so EVERY live aify
//     pane looked empty and would have been typed into. The guard is now the pane's `terminal_id`,
//     measured to change across a real restart (term_...092be1 -> term_...760e4a1).
//   - `pruneTo([])` deleted every record on the host. An empty listing is not evidence.
//   - A corrupt ledger loaded as empty and was then written over, turning one bad write into
//     permanent total loss.

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
  paneIsFreeToRelaunch,
  restorePlan,
} from "../lib/herdr-restore.mjs";

const LABEL = paneLabel({ wrapper: "claude-aify", record: "rec1" });
const CLAIMED_TERMINAL = "term_65b3d4c4092be1";
const NEW_TERMINAL = "term_65b3d4c760e4a1";

/** An aify pane as it comes back from a RESTART: label kept, a NEW pty, no agent. */
function restartedPane(overrides = {}) {
  return { pane_id: "w1:p2", label: LABEL, cwd: "C:\\work", terminal_id: NEW_TERMINAL, ...overrides };
}

/** The same pane after a LIVE HANDOFF: the pty survived, so the wrapper is still running in it. */
function handedOffPane(overrides = {}) {
  return { pane_id: "w1:p2", label: LABEL, cwd: "C:\\work", terminal_id: CLAIMED_TERMINAL, ...overrides };
}

function ledgerFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-ledger-")), "panes.json");
}

function oneRecord() {
  return new Map([
    ["rec1", { wrapper: "claude-aify", argv: ["claude-aify", "--resume"], cwd: "C:\\work", terminalId: CLAIMED_TERMINAL }],
  ]);
}

test("a pane that came back on a NEW pty is relaunched with the argv that was recorded", () => {
  const plan = restorePlan({ panes: [restartedPane()], records: oneRecord() });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].paneId, "w1:p2");
  assert.deepEqual(plan[0].argv, ["claude-aify", "--resume"]);
});

test("a pane whose PTY SURVIVED is never relaunched into, which is the live-handoff case", () => {
  // THE DEFECT THIS PINS. Herdr runs the startup hook again when a new server takes over, and a
  // handoff keeps the PTY: the wrapper is still running, the new server has no agent report for it
  // (an aify pane persists none, by design), so the old absence-based guard called it empty.
  assert.deepEqual(restorePlan({ panes: [handedOffPane()], records: oneRecord() }), []);
});

test("a pane with no terminal id at all is refused, because we cannot tell", () => {
  // A guard that passes when its input is missing is decoration.
  assert.deepEqual(restorePlan({ panes: [restartedPane({ terminal_id: undefined })], records: oneRecord() }), []);
  assert.deepEqual(restorePlan({ panes: [restartedPane({ terminal_id: "" })], records: oneRecord() }), []);
});

test("the pane Herdr resumed itself is left alone", () => {
  const native = {
    pane_id: "w1:p1",
    agent: "claude",
    terminal_id: NEW_TERMINAL,
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "bogus" },
  };
  assert.deepEqual(restorePlan({ panes: [native], records: oneRecord() }), []);
});

test("an occupied pane is refused even on a new pty, proven by adding each sign of life separately", () => {
  assert.equal(restorePlan({ panes: [restartedPane()], records: oneRecord() }).length, 1, "positive control");
  for (const sign of [{ agent_session: { source: "herdr:aify", agent: "claude-aify", kind: "id", value: "x" } }, { agent: "claude-aify" }]) {
    assert.deepEqual(restorePlan({ panes: [restartedPane(sign)], records: oneRecord() }), [],
      `a pane carrying ${JSON.stringify(sign)} was relaunched into`);
  }
});

test("paneIsFreeToRelaunch needs a record, and says no without one", () => {
  assert.equal(paneIsFreeToRelaunch(restartedPane(), null), false);
  assert.equal(paneIsFreeToRelaunch(null, { terminalId: CLAIMED_TERMINAL }), false);
  assert.equal(paneIsFreeToRelaunch(restartedPane(), { terminalId: CLAIMED_TERMINAL }), true);
});

test("a pane nobody labelled, a label with no record, and a pane with no id are left alone", () => {
  assert.deepEqual(restorePlan({ panes: [{ pane_id: "w1:p5", terminal_id: NEW_TERMINAL }], records: oneRecord() }), []);
  assert.deepEqual(restorePlan({ panes: [restartedPane()], records: new Map() }), []);
  assert.deepEqual(restorePlan({ panes: [restartedPane({ pane_id: undefined })], records: oneRecord() }), []);
});

test("the ledger round-trips through a real file", () => {
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify"], cwd: "C:\\work", terminalId: CLAIMED_TERMINAL })
    .save();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, LEDGER_VERSION);
  const reloaded = new HerdrPaneLedger({ file }).load();
  assert.equal(reloaded.get("rec1").wrapper, "claude-aify");
  assert.equal(reloaded.get("rec1").terminalId, CLAIMED_TERMINAL);
  assert.equal(reloaded.unreadable, false);
});

test("a record needs wrapper, terminalId and argv — but NOT cwd", () => {
  const ledger = new HerdrPaneLedger({ file: ledgerFile() });
  const complete = { wrapper: "claude-aify", argv: ["claude-aify"], terminalId: CLAIMED_TERMINAL };
  ledger.remember("ok", complete);
  for (const field of ["wrapper", "argv", "terminalId"]) {
    const broken = { ...complete };
    delete broken[field];
    assert.throws(() => ledger.remember("x", broken), /record needs/, `${field} was dropped and accepted`);
  }
  // cwd is DIAGNOSTIC. Requiring it silently dropped a pane's restore to enforce a field nothing reads.
  assert.doesNotThrow(() => ledger.remember("no-cwd", complete));
  assert.equal(ledger.get("no-cwd").cwd, null);
});

test("a missing ledger is empty; a CORRUPT one is unreadable and is never written over", () => {
  // THE AMPLIFIER THIS ENDS. A corrupt file used to load as empty, and the next save wrote that
  // emptiness over it -- one bad write deleting every record on the host, permanently, silently.
  const file = ledgerFile();
  const missing = new HerdrPaneLedger({ file }).load();
  assert.equal(missing.all().size, 0);
  assert.equal(missing.unreadable, false, "a file that was never written is not corrupt");

  fs.writeFileSync(file, "{ this is not json");
  const damaged = new HerdrPaneLedger({ file }).load();
  assert.equal(damaged.unreadable, true);
  const saved = damaged.save();
  assert.equal(saved.saved, false, "a damaged ledger was overwritten");
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json", "the damaged content was not preserved");
  assert.ok(fs.existsSync(`${file}.unreadable`), "no copy was kept beside it");
});

test("pruning REFUSES an empty listing instead of deleting everything", () => {
  // PROVEN DEFECT: pruneTo([]) emptied the ledger. A startup hook that fires before Herdr has
  // restored the panes, or a fresh workspace, produces exactly that empty list.
  const ledger = new HerdrPaneLedger({ file: ledgerFile() });
  ledger.remember("rec1", { wrapper: "claude-aify", argv: ["a"], terminalId: CLAIMED_TERMINAL });
  ledger.remember("rec2", { wrapper: "hermes-aify", argv: ["b"], terminalId: CLAIMED_TERMINAL });
  const refused = ledger.pruneTo([]);
  assert.equal(refused.pruned, 0);
  assert.equal(refused.refused, 2);
  assert.equal(ledger.all().size, 2, "an empty pane listing deleted the ledger");

  // POSITIVE CONTROL: with a real listing it does prune, or the refusal above proves nothing.
  const pruned = ledger.pruneTo([LABEL, "somebody-elses-pane"]);
  assert.equal(pruned.pruned, 1);
  assert.deepEqual([...ledger.all().keys()], ["rec1"]);
});

test("a save is atomic, so a reader never sees half a file", () => {
  // Written to a temp path and renamed over the target; the target must never be the write target.
  const file = ledgerFile();
  const written = [];
  const io = {
    ...fs,
    writeFileSync: (target, body, opts) => {
      written.push(target);
      return fs.writeFileSync(target, body, opts);
    },
  };
  const ledger = new HerdrPaneLedger({ file, io });
  ledger.remember("rec1", { wrapper: "w", argv: ["a"], terminalId: CLAIMED_TERMINAL });
  ledger.save();
  assert.equal(written.length, 1);
  assert.notEqual(written[0], file, "the ledger was written in place rather than renamed over");
  assert.ok(written[0].startsWith(file), "the temp file must sit beside the target, for an atomic rename");
  assert.equal(new HerdrPaneLedger({ file }).load().get("rec1").wrapper, "w");
});

test("the ledger path is configurable, which is what keeps two Herdr servers off one file", () => {
  const home = path.join("C:", "Users", "Someone");
  assert.ok(defaultLedgerPath({ home, env: {} }).includes(".aify"));
  const moved = defaultLedgerPath({ home, env: { AIFY_HERDR_LEDGER: path.join("D:", "s", "panes.json") } });
  assert.equal(moved, path.resolve(path.join("D:", "s", "panes.json")));
  for (const blank of ["", "   "]) {
    assert.ok(defaultLedgerPath({ home, env: { AIFY_HERDR_LEDGER: blank } }).includes(".aify"));
  }
});
