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

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;
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
 * An UNVERIFIED instance may be alive, so nothing of it is touched and the claim goes ahead: a start is
 * never blocked by a question this host cannot answer, and nothing is killed on one.
 *
 * @returns {{decision: "claim"|"refuse", live: object|null, stop: object[], unverified: object[], keepAttached: boolean}}
 */
export function planClaim(record, { selfPid, intent, stateOf }) {
  const plan = { decision: "claim", live: null, stop: [], unverified: [], keepAttached: false };
  const instance = record?.instance;
  if (!instance) return plan;

  let state = stateOf(instance);
  if (instance.pid === selfPid) {
    // The same launcher claiming again keeps what it attached. The same pid with another start time
    // is a previous instance whose pid this launcher was handed: that one is gone.
    if (state === "ours") return { ...plan, keepAttached: true };
    state = "gone";
  }
  if (state === "unverified") return { ...plan, unverified: [instance] };
  if (state === "ours" && intent !== "replace") return { ...plan, decision: "refuse", live: instance };
  if (state === "ours") plan.stop.push(instance);

  for (const entry of Array.isArray(instance.attached) ? instance.attached : []) {
    if (entry?.pid === selfPid) continue;
    const attachedState = stateOf(entry);
    if (attachedState === "ours") plan.stop.push(entry);
    else if (attachedState === "unverified") plan.unverified.push(entry);
  }
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
   * @returns {{decision: "claim"|"refuse", reason?: string, live?: object, stopped: object[], unverified: object[]}}
   */
  claim({ pid, runtime = "", mode = "", intent = "start" }) {
    return this.#locked(() => {
      const record = this.read();
      const pids = [pid, record?.instance?.pid, ...(record?.instance?.attached || []).map((e) => e?.pid)];
      const times = this.probe.startTimes(pids);
      const plan = planClaim(record, { selfPid: pid, intent, stateOf: (entry) => this.#state(entry, times) });
      if (plan.decision === "refuse") return { decision: "refuse", reason: "live", live: plan.live, stopped: [], unverified: plan.unverified };

      for (const entry of plan.stop) this.probe.killTree(entry.pid);
      const survivors = this.#waitGone(plan.stop);
      if (survivors.length) return { decision: "refuse", reason: "could-not-stop", live: survivors[0], stopped: [], unverified: plan.unverified };

      this.#write({
        version: LEASE_VERSION,
        agentId: this.agentId,
        instance: {
          pid,
          startedAtMs: times.get(pid) ?? null,
          runtime,
          mode,
          intent,
          claimedAtMs: this.now(),
          attached: plan.keepAttached ? record.instance.attached || [] : [],
        },
      });
      return { decision: "claim", stopped: plan.stop, unverified: plan.unverified };
    });
  }

  /** Record a process the instance `instance` started. Ignored when that instance no longer holds the lease. */
  attach({ instance, pid, kind }) {
    return this.#locked(() => {
      const record = this.read();
      if (!record || record.instance.pid !== instance) return { attached: false, reason: "not-the-current-instance" };
      const startedAtMs = this.probe.startTimes([pid]).get(pid) ?? null;
      const attached = (record.instance.attached || []).filter((entry) => entry?.pid !== pid);
      attached.push({ pid, startedAtMs, kind: String(kind || "") });
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

  #locked(work) {
    this.io.mkdirSync(this.directory, { recursive: true });
    const lock = `${this.file}.lock`;
    const deadline = this.now() + this.lockWaitMs;
    for (;;) {
      try {
        this.io.writeFileSync(lock, String(process.pid), { flag: "wx" });
        break;
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        let age = 0;
        try {
          age = this.now() - this.io.statSync(lock).mtimeMs;
        } catch {
          continue;
        }
        if (age > LOCK_STALE_MS) {
          this.io.rmSync(lock, { force: true });
          continue;
        }
        if (this.now() >= deadline) throw new LeaseBusyError(`another start of ${this.agentId} holds ${lock}`);
        processes.sleepMs(100);
      }
    }
    try {
      return work();
    } finally {
      this.io.rmSync(lock, { force: true });
    }
  }
}
