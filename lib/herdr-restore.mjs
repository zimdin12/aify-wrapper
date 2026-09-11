// What an aify pane was running, kept where Herdr cannot keep it, and the decision about which
// restored panes get it back.
//
// WHY A LEDGER EXISTS AT ALL. Herdr persists six things about a pane and a plugin may write none of
// them: there is no plugin metadata on a pane, and `launch_argv` is replayed only for imported
// panes. Measured on a real stop/start, an aify-sourced pane came back carrying exactly `cwd` and
// `label`. So the label is the handle and everything else lives here.
//
// THE GUARD IS THE PTY, NOT THE ABSENCE OF AN AGENT. The first version of this decided a pane was
// free to relaunch into when Herdr reported no agent on it -- which is wrong in the one case that
// matters. Herdr runs a plugin's startup hook again when a NEW SERVER TAKES OVER during a live
// handoff, and a handoff keeps the PTYs: the wrapper is still running, but the new server has no
// agent report for it, because an aify pane deliberately persists none. Every live aify pane would
// have looked empty and been typed into, putting two agents on one terminal.
//
// So a record carries the pane's `terminal_id`, and a relaunch requires the pane's CURRENT terminal
// id to be present and DIFFERENT. Measured across a real restart, `term_65b3d4c4092be1` became
// `term_65b3d4c760e4a1` -- a new PTY means the old process is gone. A same id means it is not, and a
// missing id means we cannot tell, which fails closed.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parsePaneLabel } from "./herdr-pane.mjs";

export const LEDGER_VERSION = 1;

/**
 * Where the ledger lives.
 *
 * `AIFY_HERDR_LEDGER` IS A REAL CONFIGURATION, not a test hook. It is what keeps a dedicated
 * `herdr-aify` instance off the shared ledger: without it, two Herdr servers on one host share one
 * file, and whichever runs a restore first prunes away every record belonging to the other.
 */
export function defaultLedgerPath({ home = os.homedir(), env = process.env } = {}) {
  const override = env?.AIFY_HERDR_LEDGER;
  if (typeof override === "string" && override.trim() !== "") return path.resolve(override);
  return path.join(home, ".aify", "herdr", "panes.json");
}

/**
 * One pane's launch, as it must be replayed.
 *
 * `argv` and `terminalId` ARE THE REQUIRED PAIR. The argv is what gets replayed; the terminal id is
 * what decides whether replaying is safe. `cwd` is recorded for the operator to read in `status` and
 * is deliberately NOT required -- an earlier version rejected any record without it, which silently
 * dropped the pane's restore to enforce a field nothing reads.
 */
function normalizeRecord(entry) {
  const argv = Array.isArray(entry?.argv) ? entry.argv.map(String) : [];
  const wrapper = String(entry?.wrapper || "");
  const terminalId = String(entry?.terminalId || "");
  if (argv.length === 0 || !wrapper || !terminalId) return null;
  return {
    wrapper,
    argv,
    terminalId,
    cwd: entry?.cwd ? String(entry.cwd) : null,
    workspaceId: entry?.workspaceId ? String(entry.workspaceId) : null,
    recordedAt: entry?.recordedAt ? String(entry.recordedAt) : null,
  };
}

/**
 * The record store. Has identity (a file) and state (the records), so it is an object; the decision
 * it feeds is a function.
 */
export class HerdrPaneLedger {
  #file;
  #io;
  #records;
  #unreadable = false;

  constructor({ file = defaultLedgerPath(), io = fs } = {}) {
    this.#file = file;
    this.#io = io;
    this.#records = new Map();
  }

  get file() {
    return this.#file;
  }

  /**
   * True when the file exists but could not be understood.
   *
   * THIS IS WHY A CORRUPT LEDGER IS NOT SILENTLY REPLACED. An unreadable file used to load as an
   * empty ledger, and the next `save()` wrote that emptiness over it -- so one damaged write deleted
   * every pane record on the host, permanently, with no error at any point.
   */
  get unreadable() {
    return this.#unreadable;
  }

  /**
   * Read what is on disk. A MISSING file is an empty ledger, which is the ordinary state on a host
   * where no wrapper has claimed a pane. A DAMAGED file is a different thing and is remembered as
   * such, because the two must not lead to the same write.
   */
  load() {
    this.#records = new Map();
    this.#unreadable = false;
    let raw;
    try {
      raw = this.#io.readFileSync(this.#file, "utf8");
    } catch {
      return this;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#unreadable = true;
      return this;
    }
    const entries = parsed && typeof parsed === "object" ? parsed.records : null;
    if (!entries || typeof entries !== "object") {
      this.#unreadable = true;
      return this;
    }
    for (const [key, value] of Object.entries(entries)) {
      const record = normalizeRecord(value);
      if (record) this.#records.set(key, record);
    }
    return this;
  }

  get(recordId) {
    return this.#records.get(recordId) || null;
  }

  all() {
    return new Map(this.#records);
  }

  remember(recordId, entry) {
    const record = normalizeRecord(entry);
    if (!record) throw new Error("herdr_restore: a record needs wrapper, terminalId and a non-empty argv");
    this.#records.set(recordId, record);
    return this;
  }

  forget(recordId) {
    this.#records.delete(recordId);
    return this;
  }

  /**
   * Drop records no live pane claims any more, so the ledger tracks the machine instead of growing
   * forever.
   *
   * IT REFUSES TO PRUNE AGAINST AN EMPTY LISTING. "Herdr has no panes" and "I asked the wrong Herdr,
   * or asked before it restored anything" produce the same empty array, and acting on the second
   * deletes every record on the host. A listing with no panes in it is therefore not evidence that
   * any record is dead, and this returns the count it refused so the caller can say so.
   */
  pruneTo(liveLabels) {
    const labels = [...(liveLabels || [])];
    if (labels.length === 0) return { pruned: 0, refused: this.#records.size, why: "the pane listing was empty" };
    const live = new Set();
    for (const label of labels) {
      const parsed = parsePaneLabel(label);
      if (parsed) live.add(parsed.record);
    }
    let pruned = 0;
    for (const key of [...this.#records.keys()]) {
      if (!live.has(key)) {
        this.#records.delete(key);
        pruned += 1;
      }
    }
    return { pruned, refused: 0, why: null };
  }

  /**
   * Write the ledger.
   *
   * ATOMIC, because a concurrent reader must never see half a file: the content goes to a temp file
   * beside the target and is renamed over it, which is atomic on both platforms this runs on.
   *
   * AND IT REFUSES TO OVERWRITE A FILE IT COULD NOT READ. Saving over damaged content would turn one
   * bad write into total loss; the damaged file is kept, with a copy beside it, and the caller is
   * told.
   */
  save() {
    if (this.#unreadable) {
      const kept = `${this.#file}.unreadable`;
      try {
        this.#io.copyFileSync(this.#file, kept);
      } catch {
        // The copy is a courtesy; refusing to write is the part that matters.
      }
      return { saved: false, why: `the ledger could not be read, so it was left alone (copy at ${kept})` };
    }
    const records = Object.fromEntries([...this.#records.entries()].map(([k, v]) => [k, { ...v }]));
    const body = `${JSON.stringify({ version: LEDGER_VERSION, records }, null, 1)}\n`;
    this.#io.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.tmp`;
    this.#io.writeFileSync(temp, body, { mode: 0o600 });
    this.#io.renameSync(temp, this.#file);
    return { saved: true, why: null };
  }
}

/**
 * True when a pane is genuinely free to relaunch into.
 *
 * THREE CONDITIONS, AND THE FIRST IS THE ONE THAT WAS MISSING. The pane's PTY must be a NEW one --
 * present, and different from the one recorded when the wrapper claimed it. A same terminal id means
 * the process from that claim is still attached to it, which is exactly the live-handoff case; an
 * absent id means we cannot tell, and a guard that passes when its input is missing is decoration.
 * After that, an agent Herdr does know about still disqualifies the pane.
 */
export function paneIsFreeToRelaunch(pane, record) {
  if (!pane || typeof pane !== "object" || !record) return false;
  const terminalId = pane.terminal_id == null ? "" : String(pane.terminal_id);
  if (!terminalId) return false;
  if (terminalId === record.terminalId) return false;
  if (pane.agent_session != null) return false;
  if (pane.agent != null && String(pane.agent) !== "") return false;
  return true;
}

/**
 * Which panes to relaunch, and with what.
 *
 * A pane qualifies only if it carries a label this module owns, that label names a record we hold,
 * and the pane is free by the rule above. Anything else is left alone.
 */
export function restorePlan({ panes = [], records = new Map() } = {}) {
  const plan = [];
  for (const pane of panes) {
    const parsed = parsePaneLabel(pane?.label);
    if (!parsed) continue;
    const record = records.get(parsed.record);
    if (!record) continue;
    if (!paneIsFreeToRelaunch(pane, record)) continue;
    plan.push(
      Object.freeze({
        paneId: String(pane.pane_id ?? ""),
        record: parsed.record,
        wrapper: record.wrapper,
        argv: [...record.argv],
        cwd: record.cwd,
      }),
    );
  }
  return plan.filter(entry => entry.paneId !== "");
}
