// One live instance of an agent per host, written down where every launcher can read it.
//
// THE OPERATOR'S RULE (2026-09-14): "we should never allow 2 of same agent to run basically (resident or
// managed, doesnt matter)". Asked how, they chose: LEFTOVERS ARE ALWAYS STOPPED -- a process that belongs
// to the agent while its instance is already gone -- and a LIVE instance is replaced only on an explicit
// start. An automatic start meeting a live instance is refused. Replacing on every start was built once
// and reverted: a message woke an idle lane and the host killed four working sessions in ten minutes.
//
// WHY A FILE. aify-env's second-worker refusal lives in one daemon's memory, so a daemon restart forgets
// it and a resident launch never reaches it. On 2026-09-14 three hermes agents refused every message
// because the previous generation's gateway still held their session, and nothing anywhere recorded
// which process that was. A launcher writes the record before its runtime starts; anything it starts
// detached ATTACHES to it; a clean exit releases it. A hard kill skips the release, which is the case
// the record exists for: the next claim finds a dead instance and stops what it left behind.
//
// The design, and the measurements it was corrected by, are in aify-comms
// docs/superpowers/plans/2026-09-14-one-live-instance-per-agent.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as processes from "./process-identity.mjs";

export const LEASE_VERSION = 1;

/** The launcher exit status for a refused start (EX_TEMPFAIL): try again once the live one is gone. */
export const REFUSED_EXIT_CODE = 75;

/** `replace` stops a live instance; `start` is refused by one. */
export const START_INTENTS = Object.freeze(["start", "replace"]);

/**
 * A lock older than this is abandoned even if its holder still runs: a claim is bounded by its probes'
 * own timeouts (a start-time query, a table read, a kill, the stop wait), all well inside it.
 */
const LOCK_STALE_MS = 120_000;
/** Longer than a claim that has to stop something on Windows takes (about 575 ms a CIM call, 10 s stop wait). */
const LOCK_WAIT_MS = 60_000;
/** How often a waiter asks again whether the holder is still alive. */
const LOCK_REJUDGE_MS = 2_000;
/** A lock naming no holder at all is abandoned after this long. */
const UNREADABLE_LOCK_MS = 10_000;
const STOP_WAIT_MS = 10_000;

export class LeaseBusyError extends Error {}

export function leaseDirectory({ env = process.env, home = os.homedir() } = {}) {
  return env.AIFY_AGENT_LEASE_DIR || path.join(home, ".aify", "agents");
}

/** The record's file name. An id outside the service's own alphabet is refused, never rewritten. */
export function leaseFileName(agentId) {
  const id = String(agentId ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) throw new Error(`not an agent id this lease can name: ${JSON.stringify(id)}`);
  return `${id}.json`;
}

/**
 * The intent a launch carries. An explicit one wins. Otherwise a person at a terminal is explicit
 * (`replace`) and a managed launch, which the service or a host started, is not (`start`).
 */
export function startIntent({ explicit, mode } = {}) {
  const chosen = String(explicit ?? "").trim().toLowerCase();
  if (START_INTENTS.includes(chosen)) return chosen;
  return String(mode ?? "").trim().toLowerCase() === "managed" ? "start" : "replace";
}

/**
 * PURE. What claiming the agent means, given its record and what each recorded process is now.
 *
 * `stateOf(entry)` answers with process-identity's `identify`: ours, gone, reused or unverified.
 *
 * An UNVERIFIED entry may be alive, so nothing of it is touched and the start goes ahead: a start is
 * never blocked by a question this host cannot answer, and nothing is killed on one. But such a claim
 * WRITES NOTHING (`write: false`): the record keeps describing what could not be verified, so a later
 * claim that can read it still decides it. Carrying unverified entries into a new record was tried and
 * was worse -- a carried gateway of a still-live instance was stopped as a leftover by the next start.
 *
 * A start INSIDE the live instance -- the instance is the launcher's own ancestor, or the lease it
 * inherited -- is `nested` and refused whatever its intent: it would be a second instance of the agent,
 * and replacing the instance would end the launcher's own ancestor. Without this, a resident agent
 * running its own launcher from its shell read as a person starting the agent and killed itself. No
 * ancestor is ever stopped, whatever the record says.
 *
 * @returns {{decision: "claim"|"refuse"|"nested", live: object|null, stop: object[], unverified: object[], write: boolean, keepAttached: boolean}}
 */
export function planClaim(record, { selfPid, intent, stateOf, inherited = null, ancestry = new Set() }) {
  const plan = { decision: "claim", live: null, stop: [], unverified: [], write: true, keepAttached: false };
  const instance = record?.instance;
  if (!instance) return plan;
  const inside = (entry) => entry?.pid === inherited || ancestry.has(entry?.pid);

  let state = stateOf(instance);
  if (instance.pid === selfPid) {
    // The same launcher claiming again keeps what it attached. The same pid with another start time
    // is a previous instance whose pid this launcher was handed: that one is gone.
    if (state === "ours") return { ...plan, keepAttached: true };
    state = "gone";
  }
  if (state === "ours" && inside(instance)) return { ...plan, decision: "nested", live: instance };
  if (state === "ours" && intent !== "replace") return { ...plan, decision: "refuse", live: instance };

  const attached = Array.isArray(instance.attached) ? instance.attached : [];
  if (state === "unverified") return { ...plan, unverified: [instance], write: false };
  if (state === "ours" && !ancestry.has(instance.pid)) plan.stop.push(instance);

  for (const entry of attached) {
    if (entry?.pid === selfPid || ancestry.has(entry?.pid)) continue;
    const attachedState = stateOf(entry);
    if (attachedState === "ours") plan.stop.push(entry);
    else if (attachedState === "unverified") plan.unverified.push(entry);
  }
  plan.write = plan.unverified.length === 0;
  return plan;
}

/** The lease of one agent on this host. Every change happens under an exclusive lock file. */
export class AgentLease {
  constructor({ agentId, directory = leaseDirectory(), io = fs, probe = processes, now = Date.now, lockWaitMs = LOCK_WAIT_MS, stopWaitMs = STOP_WAIT_MS }) {
    this.agentId = String(agentId ?? "").trim();
    this.file = path.join(directory, leaseFileName(this.agentId));
    this.directory = directory;
    this.io = io;
    this.probe = probe;
    this.now = now;
    this.lockWaitMs = lockWaitMs;
    this.stopWaitMs = stopWaitMs;
  }

  /** Read the record; a missing or unreadable one is no record. */
  read() {
    try {
      const record = JSON.parse(this.io.readFileSync(this.file, "utf8"));
      return record && typeof record === "object" && record.instance ? record : null;
    } catch {
      return null;
    }
  }

  /**
   * Take the lease for the launcher `pid`. Stops what the plan says to stop and waits for it to go.
   * `inherited` is the AIFY_AGENT_LEASE this launcher was started with, if any.
   * @returns {{decision: "claim"|"refuse"|"nested", reason?: string, live?: object, stopped: object[], unverified: object[]}}
   */
  claim({ pid, runtime = "", mode = "", intent = "start", inherited = null }) {
    return this.#locked((stillHeld) => {
      const record = this.read();
      const pids = [pid, record?.instance?.pid, ...(record?.instance?.attached || []).map((e) => e?.pid)];
      const times = this.probe.startTimes(pids);
      const stateOf = (entry) => this.#state(entry, times);
      let plan = planClaim(record, { selfPid: pid, intent, stateOf, inherited });
      let table;
      if (plan.decision === "refuse" || plan.stop.length) {
        // Only now is the process table worth its cost: something would be refused or stopped, and an
        // ancestor of this launcher must be neither.
        table = this.probe.processTable?.() ?? null;
        const ancestry = new Set([...processes.ancestors(pid, table), ...processes.ancestors(process.pid, table)]);
        plan = planClaim(record, { selfPid: pid, intent, stateOf, inherited, ancestry });
      }
      if (plan.decision === "nested") return { decision: "nested", live: plan.live, stopped: [], unverified: plan.unverified };
      if (plan.decision === "refuse") return { decision: "refuse", reason: "live", live: plan.live, stopped: [], unverified: plan.unverified };
      if (plan.stop.length && !table) {
        // Without the table neither the claimer's ancestry nor a tree can be known, and a kill decided
        // blind is the one this library must not make. A live instance cannot be replaced; leftovers
        // stay on record for a claim that can read the table.
        const live = plan.stop.find((entry) => entry.pid === record.instance.pid);
        if (live) return { decision: "refuse", reason: "could-not-stop", live, stopped: [], unverified: plan.unverified };
        return { decision: "claim", stopped: [], unverified: [...plan.unverified, ...plan.stop], written: false };
      }

      for (const entry of plan.stop) this.probe.killTree(entry.pid, { table, spare: [pid] });
      const survivors = this.#waitGone(plan.stop);
      if (survivors.length) return { decision: "refuse", reason: "could-not-stop", live: survivors[0], stopped: [], unverified: plan.unverified };

      if (!plan.write) return { decision: "claim", stopped: plan.stop, unverified: plan.unverified, written: false };
      if (!stillHeld()) throw new LeaseBusyError(`another start of ${this.agentId} took the lock during this claim`);
      const seenAliveAtMs = this.now();
      this.#write({
        version: LEASE_VERSION,
        agentId: this.agentId,
        instance: {
          pid,
          startedAtMs: times.get(pid) ?? this.#startTimeOf(pid),
          seenAliveAtMs,
          runtime,
          mode,
          intent,
          claimedAtMs: seenAliveAtMs,
          attached: plan.keepAttached ? record.instance.attached || [] : [],
        },
      });
      return { decision: "claim", stopped: plan.stop, unverified: plan.unverified, written: true };
    });
  }

  /** Record a process the instance `instance` started. Ignored when that instance no longer holds the lease. */
  attach({ instance, pid, kind }) {
    return this.#locked(() => {
      const record = this.read();
      if (!record || record.instance.pid !== instance) return { attached: false, reason: "not-the-current-instance" };
      if (!this.probe.isAlive(pid)) return { attached: false, reason: "not-running" };
      const seenAliveAtMs = this.now();
      const startedAtMs = this.#startTimeOf(pid);
      const attached = (record.instance.attached || []).filter((entry) => entry?.pid !== pid);
      attached.push({ pid, startedAtMs, seenAliveAtMs, kind: String(kind || "") });
      this.#write({ ...record, instance: { ...record.instance, attached } });
      return { attached: true };
    });
  }

  /** Give the lease up, if the launcher `pid` still holds it. */
  release({ pid }) {
    return this.#locked(() => {
      const record = this.read();
      if (!record || record.instance.pid !== pid) return { released: false };
      this.io.rmSync(this.file, { force: true });
      return { released: true };
    });
  }

  #state(entry, times) {
    return processes.identify(entry, { alive: this.probe.isAlive(entry?.pid), startedAt: times.get(entry?.pid) });
  }

  /** One pid's start time, asked twice: a single failed probe must not leave the record unverifiable. */
  #startTimeOf(pid) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = this.probe.startTimes([pid]).get(pid);
      if (at) return at;
      if (attempt === 0) processes.sleepMs(250);
    }
    return null;
  }

  #waitGone(entries) {
    const deadline = this.now() + this.stopWaitMs;
    let left = entries;
    while (left.length) {
      const times = this.probe.startTimes(left.map((entry) => entry.pid));
      left = left.filter((entry) => this.#state(entry, times) === "ours");
      if (!left.length || this.now() >= deadline) break;
      processes.sleepMs(250);
    }
    return left;
  }

  #write(record) {
    const temp = `${this.file}.${process.pid}.tmp`;
    this.io.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    this.io.renameSync(temp, this.file);
  }

  /**
   * Whether the lock text names a holder that is gone.
   *
   * The holder writes its pid and the moment it took the lock, which identifies it without a start time
   * (see `identify`). The helper before 0.6.5's review wrote only a pid, which is read with the lock
   * file's own mtime as the moment. A lock with no readable holder at all -- empty, or cut short by a
   * crash between create and write -- is abandoned once it is older than a claim's first instant could
   * leave it.
   */
  #lockAbandoned(text, ageMs, mtimeMs) {
    if (ageMs > LOCK_STALE_MS) return true;
    let holder;
    try {
      holder = JSON.parse(text);
    } catch {
      holder = null;
    }
    if (typeof holder === "number") holder = { pid: holder, atMs: mtimeMs };
    const pid = Number(holder?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return ageMs > UNREADABLE_LOCK_MS;
    const state = processes.identify({ seenAliveAtMs: Number(holder.atMs) || mtimeMs }, {
      alive: this.probe.isAlive(pid),
      startedAt: this.probe.startTimes([pid]).get(pid),
    });
    return state === "gone" || state === "reused";
  }

  #locked(work) {
    this.io.mkdirSync(this.directory, { recursive: true });
    const lock = `${this.file}.lock`;
    const token = JSON.stringify({ pid: process.pid, atMs: this.now(), nonce: Math.random().toString(36).slice(2) });
    const deadline = this.now() + this.lockWaitMs;
    // A verdict is re-asked every LOCK_REJUDGE_MS: a holder seen alive can die while this start waits,
    // and a verdict cached for the whole wait refused every waiter behind a dead holder.
    let judgedText = null;
    let judgedAt = 0;
    let abandoned = false;
    for (;;) {
      try {
        this.io.writeFileSync(lock, token, { flag: "wx" });
        break;
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        let text;
        let mtimeMs;
        try {
          text = String(this.io.readFileSync(lock, "utf8"));
          mtimeMs = this.io.statSync(lock).mtimeMs;
        } catch {
          continue;
        }
        if (text !== judgedText || this.now() - judgedAt >= LOCK_REJUDGE_MS) {
          abandoned = this.#lockAbandoned(text, this.now() - mtimeMs, mtimeMs);
          judgedText = text;
          judgedAt = this.now();
        }
        if (abandoned) {
          this.#takeOver(lock, text);
          judgedText = null;
          continue;
        }
        if (this.now() >= deadline) throw new LeaseBusyError(`another start of ${this.agentId} holds ${lock} (${text})`);
        processes.sleepMs(100);
      }
    }
    try {
      return work(() => this.#holds(lock, token));
    } finally {
      // Only our own lock: after a takeover race another start may hold this path now.
      if (this.#holds(lock, token)) this.io.rmSync(lock, { force: true });
    }
  }

  #holds(lock, token) {
    try {
      return String(this.io.readFileSync(lock, "utf8")) === token;
    } catch {
      return false;
    }
  }

  /**
   * Remove an abandoned lock without removing a fresh one. The lock is RENAMED away, which only one
   * waiter can do; if what was renamed is not the lock that was judged abandoned, another waiter
   * already took over and wrote its own, and that one is put back.
   *
   * A window remains between that rename and the put-back in which a third start can take the path.
   * Two holders are then possible, so a claim re-reads the lock just before it writes the record and
   * throws when it no longer holds it: the record, which every later decision reads, is never written by
   * a start that lost the lock. What that start already stopped stays stopped.
   */
  #takeOver(lock, judgedText) {
    const moved = `${lock}.${process.pid}.${this.now()}.${Math.random().toString(36).slice(2)}.abandoned`;
    try {
      this.io.renameSync(lock, moved);
    } catch {
      return;
    }
    let text = judgedText;
    try {
      text = String(this.io.readFileSync(moved, "utf8"));
    } catch {
      // Nothing to compare: treat it as the judged lock.
    }
    this.io.rmSync(moved, { force: true });
    if (text !== judgedText) {
      try {
        this.io.writeFileSync(lock, text, { flag: "wx" });
      } catch {
        // Somebody holds it again already.
      }
    }
  }
}
