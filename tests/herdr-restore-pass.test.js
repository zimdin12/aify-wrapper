#!/usr/bin/env node
// The restore PASS itself — the function the plugin's startup hook runs — against a real ledger file.
//
// WHY THIS EXISTS SEPARATELY FROM THE PLAN TESTS. `restorePlan` is pure and well covered, and it was
// not where the damage was. The damage was in the ORDER of the pass around it: review proved that
// pruning used the ledger snapshot taken BEFORE the relaunches, so the records the relaunched
// wrappers had just written for themselves were deleted by the very pass that started them. The
// feature therefore worked exactly once per pane and then stopped for ever, silently — every pane
// afterwards carrying a label whose record no longer existed.
//
// SO THE FAKE HERE DOES WHAT A REAL RELAUNCH DOES: when the pass types a wrapper command into a
// pane, the fake writes that wrapper's OWN new record into the same ledger file, exactly as the
// wrapper's `claim` would. If the pass prunes against its stale snapshot, that record disappears and
// this test fails.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { restore } from "../bin/aify-herdr-pane.mjs";
import { paneLabel } from "../lib/herdr-pane.mjs";
import { HerdrPaneLedger } from "../lib/herdr-restore.mjs";

const OLD_TERMINAL = "term_before";
const NEW_TERMINAL = "term_after";
const OLD_LABEL = paneLabel({ wrapper: "claude-aify", record: "rec1" });
const NEW_LABEL = paneLabel({ wrapper: "claude-aify", record: "rec2" });
//: The moment the pass takes its listing, injected so "written after the listing" is exact.
const LISTED_AT = Date.parse("2026-09-13T10:00:00.000Z");

function ledgerFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-pass-")), "panes.json");
}

/**
 * A Herdr that lists one restored aify pane, and — when a command is typed into it — does what the
 * relaunched wrapper really does: claims the pane under a NEW record and writes it to the ledger.
 */
function fakeHerdr(file, { panes, onRun }) {
  const typed = [];
  return {
    typed,
    // A COPY, as a real CLI response is. This returned the SAME array the "wrapper" below renames a
    // pane in, so a listing taken BEFORE the relaunch saw the label written AFTER it -- which made the
    // test below pass against the exact defect it names. Found by review: detaching the response
    // alone turned it 5 pass / 1 fail.
    listPanes: () => ({ ok: true, panes: structuredClone(panes), error: null }),
    herdr: (argv) => {
      if (argv[0] === "pane" && argv[1] === "run") {
        typed.push(argv[3]);
        if (onRun) onRun();
      }
      return { ok: true, json: null, error: null };
    },
  };
}

test("a record written by a relaunched wrapper SURVIVES the pass that relaunched it", () => {
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify", "--resume"], terminalId: OLD_TERMINAL })
    .save();

  const panes = [{ pane_id: "w1:p1", label: OLD_LABEL, terminal_id: NEW_TERMINAL }];
  const cli = fakeHerdr(file, {
    panes,
    onRun: () => {
      // The relaunched wrapper claims its pane: a new record, a new label on the pane.
      // AS THE REAL `claim` DOES: rename the pane first, then write a record stamped with the moment
      // it was written. A record with no stamp is not one a real wrapper ever writes.
      panes[0].label = NEW_LABEL;
      const theirs = new HerdrPaneLedger({ file }).load();
      theirs.remember("rec2", { wrapper: "claude-aify", argv: ["claude-aify"], terminalId: NEW_TERMINAL, recordedAt: new Date(LISTED_AT + 1000).toISOString() });
      theirs.save();
    },
  });

  const result = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli, now: () => LISTED_AT });
  assert.equal(result.restored.length, 1, "the pane was not relaunched at all");
  assert.deepEqual(cli.typed, ["claude-aify --resume"], "the recorded argv was not replayed");

  const after = new HerdrPaneLedger({ file }).load();
  assert.ok(after.get("rec2"), "the relaunched wrapper's own record was deleted by the pass that started it");
});

test("the pass is not repeatable against the same pane — a second run types nothing", () => {
  // FOUND BY RUNNING IT, against a real Herdr, after every unit test here was green. The record
  // still named the PRE-RESTART terminal, so the pane kept looking free: a second pass — the
  // operator's own `restore` action, or a live handoff moments later — typed the command in again,
  // on top of whatever the first pass had started.
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify"], terminalId: OLD_TERMINAL })
    .save();
  // A pane that came back on a new PTY and whose relaunched command has NOT claimed it yet, which is
  // the window this closes.
  const panes = [{ pane_id: "w1:p1", label: OLD_LABEL, terminal_id: NEW_TERMINAL }];

  const first = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli: fakeHerdr(file, { panes }) });
  assert.equal(first.restored.length, 1, "positive control: the first pass must relaunch");

  const second = fakeHerdr(file, { panes });
  const again = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli: second });
  assert.deepEqual(second.typed, [], "the second pass typed the command in again");
  assert.deepEqual(again.restored, []);
});

test("an unreadable pane listing changes nothing at all", () => {
  // "Herdr told me there are no panes" and "I could not ask Herdr" must not lead to the same write.
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify"], terminalId: OLD_TERMINAL })
    .save();
  const cli = { listPanes: () => ({ ok: false, panes: [], error: "server_not_running" }), herdr: () => ({ ok: true }) };
  const result = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli });
  assert.match(result.why, /could not read the pane list/);
  assert.equal(new HerdrPaneLedger({ file }).load().all().size, 1, "a failed listing deleted a record");
});

test("an EMPTY pane listing relaunches nothing and deletes nothing", () => {
  // A startup hook that fires before Herdr restored the panes produces exactly this.
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify"], terminalId: OLD_TERMINAL })
    .save();
  const cli = fakeHerdr(file, { panes: [] });
  const result = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli });
  assert.deepEqual(result.restored, []);
  assert.equal(result.prunedRefused, 1, "the pass did not report that it kept records it could not judge");
  assert.equal(new HerdrPaneLedger({ file }).load().all().size, 1, "an empty listing deleted the ledger");
});

test("a pane whose PTY survived is not typed into, and its record is kept", () => {
  // The live-handoff case: the wrapper is still running in that pane.
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify"], terminalId: OLD_TERMINAL })
    .save();
  const cli = fakeHerdr(file, { panes: [{ pane_id: "w1:p1", label: OLD_LABEL, terminal_id: OLD_TERMINAL }] });
  const result = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(cli.typed, [], "a command was typed into a pane whose agent is still running");
  assert.ok(new HerdrPaneLedger({ file }).load().get("rec1"), "the live pane's record was pruned");
});

test("an argv that cannot be replayed safely is REFUSED and named, not typed", () => {
  const file = ledgerFile();
  new HerdrPaneLedger({ file })
    .remember("rec1", { wrapper: "claude-aify", argv: ["claude-aify\nnet user x /add"], terminalId: OLD_TERMINAL })
    .save();
  const cli = fakeHerdr(file, { panes: [{ pane_id: "w1:p1", label: OLD_LABEL, terminal_id: NEW_TERMINAL }] });
  const result = restore({ env: {}, ledger: new HerdrPaneLedger({ file }), cli });
  assert.deepEqual(cli.typed, [], "an argv carrying a newline was typed into a live shell");
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].why, /control character/);
});
