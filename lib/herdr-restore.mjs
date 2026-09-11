// What an aify pane was running, kept where Herdr cannot keep it, and the decision about which
// restored panes get it back.
//
// WHY A LEDGER EXISTS AT ALL. Herdr persists six things about a pane, and a plugin may write none of
// them: there is no plugin metadata on a pane, and `launch_argv` is replayed only for imported
// panes. Measured on a real stop/start, an aify-sourced pane came back carrying exactly `cwd` and
// `label`. So the label is the handle and everything else — the wrapper argv, the agent id, the
// workspace — has to live in a file of ours.
//
// THE RESTORE IS A PURE DECISION WITH INJECTED IO, because the interesting failure is not reading a
// file, it is relaunching into a pane that already has an agent in it. That judgement is
// `restorePlan`, it is a function of two lists, and it is where the tests point.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parsePaneLabel } from "./herdr-pane.mjs";

export const LEDGER_VERSION = 1;

/**
 * Where the ledger lives.
 *
 * `AIFY_HERDR_LEDGER` IS A REAL CONFIGURATION, not a test hook: it is what lets an operator point a
 * throwaway or second installation somewhere else, and what lets this feature be exercised end to
 * end without writing into the live host state that the running fleet reads.
 */
export function defaultLedgerPath({ home = os.homedir(), env = process.env } = {}) {
  const override = env?.AIFY_HERDR_LEDGER;
  if (typeof override === "string" && override.trim() !== "") return path.resolve(override);
  return path.join(home, ".aify", "herdr", "panes.json");
}

/**
 * One pane's launch, as it must be replayed.
 *
 * `argv` is the REAL wrapper command, not a reconstruction. A restore that rebuilt the command from
 * a wrapper name plus remembered flags would drift from what the operator actually ran the moment
 * either side changed, and the drift would show up only after a reboot.
 */
function normalizeRecord(entry) {
  const argv = Array.isArray(entry?.argv) ? entry.argv.map(String) : [];
  if (argv.length === 0) return null;
  const wrapper = String(entry?.wrapper || "");
  const cwd = String(entry?.cwd || "");
  if (!wrapper || !cwd) return null;
  return {
    wrapper,
    argv,
    cwd,
    workspaceId: entry?.workspaceId ? String(entry.workspaceId) : null,
    recordedAt: entry?.recordedAt ? String(entry.recordedAt) : null,
  };
}

/**
 * The record store. Has identity (a file), has state (the records), so it is an object; the decision
 * it feeds is a function.
 */
export class HerdrPaneLedger {
  #file;
  #io;
  #records;

  constructor({ file = defaultLedgerPath(), io = fs } = {}) {
    this.#file = file;
    this.#io = io;
    this.#records = new Map();
  }

  get file() {
    return this.#file;
  }

  /**
   * Read what is on disk. A missing file is an empty ledger — the ordinary state on a machine that
   * has never run a wrapper under Herdr. A CORRUPT file is also empty rather than fatal: the worst
   * this loses is one reboot's relaunch, while throwing here would break every wrapper launch on the
   * host, and a wrapper that will not start is a far more expensive failure than an agent that does
   * not come back by itself.
   */
  load() {
    this.#records = new Map();
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
      return this;
    }
    const entries = parsed && typeof parsed === "object" ? parsed.records : null;
    if (!entries || typeof entries !== "object") return this;
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
    if (!record) throw new Error("herdr_restore: a record needs wrapper, cwd and a non-empty argv");
    this.#records.set(recordId, record);
    return this;
  }

  forget(recordId) {
    this.#records.delete(recordId);
    return this;
  }

  /**
   * Drop records no live pane claims any more, so the ledger tracks the machine instead of growing
   * forever. Driven by the labels Herdr reports, which is the only authority on what still exists.
   */
  pruneTo(liveLabels) {
    const live = new Set();
    for (const label of liveLabels || []) {
      const parsed = parsePaneLabel(label);
      if (parsed) live.add(parsed.record);
    }
    for (const key of [...this.#records.keys()]) {
      if (!live.has(key)) this.#records.delete(key);
    }
    return this;
  }

  save() {
    const records = Object.fromEntries([...this.#records.entries()].map(([k, v]) => [k, { ...v }]));
    this.#io.mkdirSync(path.dirname(this.#file), { recursive: true });
    this.#io.writeFileSync(this.#file, `${JSON.stringify({ version: LEDGER_VERSION, records }, null, 1)}\n`, {
      mode: 0o600,
    });
    return this;
  }
}

/**
 * True when a restored pane is an empty shell waiting to be filled.
 *
 * THIS IS THE GUARD THAT MATTERS. Herdr reports a pane's agent in two places — `agent_session` for
 * one it planned a resume for, and `agent` for one somebody reported live — and a pane holding
 * either is already occupied. Relaunching into it would put a second agent in one pane, which is
 * worse than not restoring at all, so the guard reads BOTH and any sign of life disqualifies.
 */
export function paneIsAnEmptyShell(pane) {
  if (!pane || typeof pane !== "object") return false;
  if (pane.agent_session != null) return false;
  if (pane.agent != null && String(pane.agent) !== "") return false;
  return true;
}

/**
 * Which panes to relaunch, and with what.
 *
 * A pane qualifies only if it carries a label this module owns, that label names a record we hold,
 * and the pane came back empty. Anything else is left alone: an unlabelled pane is somebody's shell,
 * an unknown record is a ledger that has lost its entry, and an occupied pane is already working.
 */
export function restorePlan({ panes = [], records = new Map() } = {}) {
  const plan = [];
  for (const pane of panes) {
    const parsed = parsePaneLabel(pane?.label);
    if (!parsed) continue;
    const record = records.get(parsed.record);
    if (!record) continue;
    if (!paneIsAnEmptyShell(pane)) continue;
    plan.push(
      Object.freeze({
        paneId: String(pane.pane_id),
        record: parsed.record,
        wrapper: record.wrapper,
        argv: [...record.argv],
        cwd: record.cwd,
      }),
    );
  }
  return plan;
}
