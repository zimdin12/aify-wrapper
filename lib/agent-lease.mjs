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
 * A lock older than this is abandoned even if its holder still runs. A claim is bounded by its probes'
 * timeouts: a table read (20 s), a kill per stopped entry (15 s), the stop wait (10 s) and one last
 * start-time query (15 s). A claim that times out on all of them while stopping five entries or more
 * can outlive this; the holder then finds its lock gone and writes no record (`#holds`).
 */
const LOCK_STALE_MS = 120_000;
/**
 * How long a start waits for another start of the same agent. Measured on Windows (2026-09-15): a table
 * read is 655-703 ms and a start-time query 480-578 ms, so a claim that stops something holds the lock
 * for about 1-12 s. A start still waiting after this is refused rather than let through.
 */
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

/** How a launch knew which agent it is: named on its own command line, or anything else. */
export const IDENTITY_FROM_FLAG = "flag";

/**
 * The intent a launch carries. An explicit one wins, and an explicit value this library does not know
 * is `start`: a guard given a word it cannot read must not end anything. With none, a managed launch,
 * which the service or a host started, is `start`; so is any launch that did not NAME its agent. Only a
 * person who named the agent on the command line is explicit enough to `replace` it.
 *
 * WHY THE NAME MATTERS, 2026-09-15: a bare `claude-aify` typed into a pane took its identity from an
 * environment inherited from comms-tech-lead's own session, read as a person starting comms-tech-lead, and
 * replaced -- killed -- it. An identity a launch did not name is a guess, and a guess never ends anything.
 * Absent, it is a guess too.
 */
export function startIntent({ explicit, mode, identity } = {}) {
  const chosen = String(explicit ?? "").trim().toLowerCase();
  if (chosen) return START_INTENTS.includes(chosen) ? chosen : "start";
  if (String(mode ?? "").trim().toLowerCase() === "managed") return "start";
  return String(identity ?? "").trim().toLowerCase() === IDENTITY_FROM_FLAG ? "replace" : "start";
}

/**
 * PURE. What claiming the agent means, given its record and what each recorded process is now.
 *
 * `stateOf(entry)` answers `ours` (the recorded process, alive), `gone`, `reused` (its pid belongs to
 * something else now) or `unknown` (alive, but the entry records nothing to identify it by -- an older
 * build wrote neither a start time nor a moment it was seen -- so it can never be proven ours: it is
 * never stopped, never refuses, and is dropped). An instance of unknown identity takes its attached
 * processes with it: they may belong to an instance that is still alive.
 *
 * A start INSIDE the live instance -- the instance is the launcher's own ancestor, or the lease it
 * inherited -- is `nested` and refused whatever its intent: it would be a second instance of the agent,
 * and replacing the instance would end the launcher's own ancestor. Without this, a resident agent
 * running its own launcher from its shell read as a person starting the agent and killed itself. No
 * ancestor is ever stopped, whatever the record says.
 *
 * @returns {{decision: "claim"|"refuse"|"nested", live: object|null, stop: object[], keepAttached: boolean}}
 */
export function planClaim(record, { selfPid, intent, stateOf, inherited = null, ancestry = new Set() }) {
  const plan = { decision: "claim", live: null, stop: [], keepAttached: false };
  const instance = record?.instance;
  if (!instance) return plan;

  let state = stateOf(instance);
  if (instance.pid === selfPid) {
    // The same launcher claiming again keeps what it attached. The same pid with another start time
    // is a previous instance whose pid this launcher was handed: that one is gone.
    if (state === "ours") return { ...plan, keepAttached: true };
    state = "gone";
  }
  if (state === "unknown") return plan;
  if (state === "ours" && (instance.pid === inherited || ancestry.has(instance.pid))) return { ...plan, decision: "nested", live: instance };
  if (state === "ours" && intent !== "replace") return { ...plan, decision: "refuse", live: instance };
  if (state === "ours") plan.stop.push(instance);

  for (const entry of Array.isArray(instance.attached) ? instance.attached : []) {
    if (entry?.pid === selfPid || ancestry.has(entry?.pid)) continue;
    if (stateOf(entry) === "ours") plan.stop.push(entry);
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
   * `inherited` is the AIFY_AGENT_LEASE this launcher was started with, if any.
   *
   * ONE PROCESS TABLE DECIDES EVERYTHING: every recorded process's identity, the launcher's ancestry, and
   * every tree a stop ends. Separate probes that could each fail on their own left gaps between them --
   * an entry nobody could verify let a live launcher go unrecorded, and the next automatic start through.
   * So when a record names a process that is still running and the table cannot be read, the start is
   * REFUSED: a retry costs a moment, a second instance is what the lease exists to prevent.
   *
   * @returns {{decision: "claim"|"refuse"|"nested", reason?: "live"|"could-not-stop"|"unreadable-processes", live?: object, stopped: object[]}}
   */
  claim({ pid, runtime = "", mode = "", intent = "start", inherited = null }) {
    return this.#locked((stillHeld) => {
      // STAMPED BEFORE ANYTHING IS OBSERVED. The launcher is running this claim, so it is alive now; a
      // later stamp would widen the window in which a reused pid reads as ours (see `identify`).
      const seenAliveAtMs = this.#seenNow();
      const record = this.read();
      const table = record ? this.probe.processTable() : null;
      if (record && !table) {
        const entries = [record.instance, ...(record.instance.attached || [])].filter((entry) => entry?.pid !== pid);
        const running = entries.find((entry) => this.probe.isAlive(entry?.pid));
        if (running) return { decision: "refuse", reason: "unreadable-processes", live: running, stopped: [] };
      }
      const ancestry = table ? new Set([...processes.ancestors(pid, table), ...processes.ancestors(process.pid, table)]) : new Set();
      const plan = planClaim(record, { selfPid: pid, intent, inherited, ancestry, stateOf: (entry) => this.#state(entry, table) });
      if (plan.decision === "nested") return { decision: "nested", live: plan.live, stopped: [] };
      if (plan.decision === "refuse") return { decision: "refuse", reason: "live", live: plan.live, stopped: [] };

      const boundaries = this.#otherAgentsProcesses(table);
      const hosts = processes.hostsOf(boundaries, table);
      // A LIVE INSTANCE HOSTING ANOTHER AGENT IS NOT REPLACED: its tree holds that agent -- a Herdr server or an
      // aify-env started from its shell, with agents inside -- and ending it would end them. Refused, named.
      const live = plan.stop.find((entry) => entry === record?.instance);
      if (live && hosts.has(live.pid)) return { decision: "refuse", reason: "hosts-another-agent", live, stopped: [] };
      // What a DEAD instance left running without attaching it -- the runtime of a launcher killed on its
      // own, the servers that runtime started -- is a leftover too, found by its parent pid. A leftover that
      // now hosts another agent belongs to that agent, and is left running.
      const orphans = record && this.#ended(record.instance, table) && plan.decision === "claim"
        ? this.#orphansOf(record.instance, table, boundaries, [pid, ...plan.stop.map((entry) => entry.pid)])
        : [];
      const stop = [...plan.stop, ...orphans].filter((entry) => !hosts.has(entry.pid));
      for (const entry of stop) this.probe.killTree(entry.pid, { table, spare: [pid], boundaries });
      const survivors = this.#waitGone(stop);
      if (survivors.length) return { decision: "refuse", reason: "could-not-stop", live: survivors[0], stopped: [] };

      if (!stillHeld()) throw new LeaseBusyError(`another start of ${this.agentId} took the lock during this claim`);
      this.#write({
        version: LEASE_VERSION,
        agentId: this.agentId,
        instance: {
          pid,
          startedAtMs: table?.get(pid)?.startedAtMs ?? this.#startTimeOf(pid),
          seenAliveAtMs,
          runtime,
          mode,
          intent,
          attached: plan.keepAttached ? record.instance.attached || [] : [],
        },
      });
      return { decision: "claim", stopped: stop };
    });
  }

  /**
   * Record a process the instance `instance` started. Ignored when that instance no longer holds the lease.
   * @returns {{attached: boolean, reason?: "not-the-current-instance"|"not-running"}}
   */
  attach({ instance, pid, kind }) {
    return this.#locked(() => {
      const record = this.read();
      if (!record || record.instance.pid !== instance) return { attached: false, reason: "not-the-current-instance" };
      const seenAliveAtMs = this.#seenNow();
      if (!this.probe.isAlive(pid)) return { attached: false, reason: "not-running" };
      const startedAtMs = this.#startTimeOf(pid);
      const attached = (record.instance.attached || []).filter((entry) => entry?.pid !== pid);
      attached.push({ pid, startedAtMs, seenAliveAtMs, kind: String(kind || "") });
      this.#write({ ...record, instance: { ...record.instance, attached } });
      return { attached: true };
    });
  }

  /**
   * Give the lease up, if the launcher `pid` still holds it, and STOP what it attached first. Everything
   * attached was started detached precisely so that nothing else ends it: a launcher's exit only signals
   * what it started (hermes kills its delivery loop, codex signals a shim), and the operator's rule is that
   * an agent that is gone leaves nothing running. Anything that will not stop, or a table that cannot be
   * read, keeps the record, so it names a dead launcher and the next claim, or the watch, stops what is left.
   * @returns {{released: boolean, reason?: "not-the-holder"|"unreadable-processes"|"could-not-stop", stopped: object[]}}
   */
  release({ pid }) {
    return this.#locked(() => {
      const record = this.read();
      if (!record || record.instance.pid !== pid) return { released: false, reason: "not-the-holder", stopped: [] };
      const attached = (record.instance.attached || []).filter((entry) => entry?.pid !== pid);
      const table = attached.length ? this.probe.processTable() : new Map();
      if (!table) return { released: false, reason: "unreadable-processes", stopped: [] };
      const stop = attached.filter((entry) => this.#state(entry, table) === "ours");
      return this.#stopAndDrop(stop, table, "released");
    });
  }

  /**
   * The instance `instance` is GONE without releasing -- its launcher was killed, its terminal closed, its
   * host tier stopped -- so stop everything it left: what it attached, and every process it started that is
   * still running. Run by the watch every claim starts. Nothing happens unless the record still names that
   * instance and the table shows it gone; a table that cannot be read, or a process that will not stop,
   * keeps the record for the next claim.
   * @returns {{collected: boolean, reason?: "not-the-holder"|"still-running"|"unreadable-processes"|"could-not-stop", stopped: object[]}}
   */
  collect({ instance }) {
    return this.#locked(() => {
      const record = this.read();
      if (!record || record.instance.pid !== instance) return { collected: false, reason: "not-the-holder", stopped: [] };
      const table = this.probe.processTable();
      if (!table) return { collected: false, reason: "unreadable-processes", stopped: [] };
      if (!this.#ended(record.instance, table)) return { collected: false, reason: "still-running", stopped: [] };
      const boundaries = this.#otherAgentsProcesses(table);
      const attached = (record.instance.attached || []).filter((entry) => this.#state(entry, table) === "ours");
      const stop = [...attached, ...this.#orphansOf(record.instance, table, boundaries, attached.map((entry) => entry.pid))];
      return this.#stopAndDrop(stop, table, "collected", boundaries);
    });
  }

  /** Whether `instance` still holds the record, and what it is now. Unlocked: the watch only decides when to collect. */
  holderState(instance) {
    const record = this.read();
    if (!record || record.instance.pid !== instance) return "not-the-holder";
    const times = this.probe.startTimes([instance], { strict: true });
    if (!times) return "unknown";
    return processes.identify(record.instance, { alive: this.probe.isAlive(instance) && times.has(instance), startedAt: times.get(instance) });
  }

  /** Stop `stop`, wait for it, and delete the record only once nothing of it is left. */
  #stopAndDrop(candidates, table, verb, boundaries = this.#otherAgentsProcesses(table)) {
    // What hosts another agent now belongs to that agent: it is left running, and does not hold the record.
    const hosts = processes.hostsOf(boundaries, table);
    const stop = candidates.filter((entry) => !hosts.has(entry.pid));
    for (const entry of stop) this.probe.killTree(entry.pid, { table, boundaries });
    const survivors = this.#waitGone(stop);
    if (survivors.length) return { [verb]: false, reason: "could-not-stop", live: survivors[0], stopped: [] };
    this.io.rmSync(this.file, { force: true });
    return { [verb]: true, stopped: stop };
  }

  /** An instance that is gone, or whose pid another process now holds. One of unknown identity is not ended. */
  #ended(instance, table) {
    const state = this.#state(instance, table);
    return state === "gone" || state === "reused";
  }

  /** The children a gone instance left running, as entries a stop can wait on. */
  #orphansOf(instance, table, boundaries, already = []) {
    const skip = new Set([...boundaries, ...already]);
    return processes.orphanedChildren(instance, table, { boundaries: skip })
      .map((row) => ({ pid: row.pid, startedAtMs: row.startedAtMs, kind: "left-running" }));
  }

  /**
   * Every pid another agent's lease on this host names: subtrees a stop of this agent never enters, and the
   * processes above them it never ends (`hostsOf`). With a table, an entry whose pid is gone or now belongs to
   * another process is not one: a stale record would otherwise make an unrelated process read as a host.
   */
  #otherAgentsProcesses(table = null) {
    const pids = new Set();
    let names = [];
    try {
      names = this.io.readdirSync(this.directory);
    } catch {
      return pids;
    }
    const own = path.basename(this.file);
    for (const name of names) {
      if (!name.endsWith(".json") || name === own) continue;
      try {
        const instance = JSON.parse(this.io.readFileSync(path.join(this.directory, name), "utf8"))?.instance;
        for (const entry of [instance, ...(instance?.attached || [])]) {
          if (!Number.isInteger(entry?.pid)) continue;
          if (table && ["gone", "reused"].includes(this.#state(entry, table))) continue;
          pids.add(entry.pid);
        }
      } catch {
        // Unreadable: nothing to spare from it.
      }
    }
    return pids;
  }

  /**
   * What a recorded entry is, read from the table. Only reached with no table when no recorded process
   * is running, so every entry is gone then. A pid the table does not list is gone whatever the entry
   * recorded; a listed pid the entry gives no way to identify (an older build wrote neither a start time
   * nor a moment it was seen) is `unknown`.
   */
  #state(entry, table) {
    const row = table?.get(entry?.pid);
    return processes.identify(entry, { alive: Boolean(row), startedAt: row?.startedAtMs });
  }

  /**
   * Now, on the clock this record's start times are written on. A record holds a start time (anchored,
   * `anchorOffsetMs`) and the moment the pid was seen alive, and `identify` compares whichever it has --
   * so both belong on ONE clock, or a record whose start time could not be read is judged across the
   * drift between them (external review, 2026-09-16).
   */
  #seenNow() {
    return this.now() + (this.probe.anchorOffsetMs?.() ?? 0);
  }

  /** One pid's start time, asked twice: a single failed probe must not leave the record unverifiable. */
  #startTimeOf(pid) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = this.probe.startTimes([pid], { strict: true })?.get(pid);
      if (at) return at;
      if (attempt === 0) processes.sleepMs(250);
    }
    return null;
  }

  /** The entries still running as themselves once the stop wait is over. A failed probe is not a gone process. */
  #waitGone(entries) {
    const deadline = this.now() + this.stopWaitMs;
    let left = entries;
    while (left.length) {
      const times = this.probe.startTimes(left.map((entry) => entry.pid), { strict: true });
      if (times) {
        left = left.filter((entry) => processes.identify(entry, {
          alive: this.probe.isAlive(entry.pid) && times.has(entry.pid),
          startedAt: times.get(entry.pid),
        }) === "ours");
      }
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
   * (see `identify`). A lock with no readable holder at all -- empty, or cut short by a crash between
   * create and write -- is abandoned once it is older than a claim's first instant could leave it.
   */
  #lockAbandoned(text, ageMs, mtimeMs) {
    if (ageMs > LOCK_STALE_MS) return true;
    let holder;
    try {
      holder = JSON.parse(text);
    } catch {
      holder = null;
    }
    const pid = Number(holder?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return ageMs > UNREADABLE_LOCK_MS;
    if (!this.probe.isAlive(pid)) return true;
    const times = this.probe.startTimes([pid], { strict: true });
    if (!times) return false;
    // The holder's moment and the lock's mtime are wall-clock; a start time is anchored (`anchorOffsetMs`).
    const offsetMs = this.probe.anchorOffsetMs?.() ?? 0;
    const state = processes.identify({ seenAliveAtMs: Number(holder.atMs) || mtimeMs }, { alive: times.has(pid), startedAt: times.get(pid), offsetMs });
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

  /**
   * Whether this start still holds the lock. A MISSING lock is asked about again for a moment first: a
   * waiter's takeover renames the lock away and puts back one it should not have taken, and a claim that
   * read the gap as lost would give up after it had already stopped the instance it was replacing.
   */
  #holds(lock, token) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return String(this.io.readFileSync(lock, "utf8")) === token;
      } catch (err) {
        if (err?.code !== "ENOENT") return false;
        processes.sleepMs(50);
      }
    }
    return false;
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
