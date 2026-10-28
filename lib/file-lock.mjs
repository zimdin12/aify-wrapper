// One holder at a time across processes, for work on a shared file: `<path>` created exclusively, holding the
// holder's pid and the moment it took it.
//
// ONLY POSITIVE EVIDENCE FREES IT. A waiter re-judges the holder every `rejudgeMs` and takes over a lock older than
// `staleMs` whatever its holder, one naming no holder for longer than `unreadableMs`, one whose holder the OS says has
// ended (`liveness` gone), or one whose pid now belongs to a process with a READABLE, later start time. Anything it
// cannot tell -- a pid it cannot probe, a probe error, a start time it cannot read, a lock it cannot read -- is
// unknown, and unknown waits until the deadline (review of ba87799, which found all three readings granted takeover).
//
// Moved here from AgentLease (lib/agent-lease.mjs), which used it alone, when the hermes config change an install
// leaves pending needed the same lock (lib/hermes-pending-config.mjs).

import fs from "node:fs";
import path from "node:path";
import * as processes from "./process-identity.mjs";

export class FileLockBusyError extends Error {}

/**
 * How many passes in a row that proved the lock free may retry the create at once, past the deadline. One is what a
 * dead holder's lock needs; the rest cover a second waiter freeing it at the same moment.
 */
const FREED_RETRIES = 3;

export class FileLock {
  /**
   * @param {object} options
   * @param {string} options.path        the lock file
   * @param {number} options.waitMs      how long to wait for a live holder before `busy`
   * @param {number} options.staleMs     a lock older than this is abandoned even if its holder still runs
   * @param {number} [options.rejudgeMs] how often a waiter asks again whether the holder is still alive
   * @param {number} [options.unreadableMs] a lock naming no holder at all is abandoned after this long
   * @param {(path: string, holder: string) => Error} [options.busy] the error thrown when the wait runs out
   */
  constructor({ path: file, waitMs, staleMs, rejudgeMs = 2_000, unreadableMs = 10_000, io = fs, probe = processes, now = Date.now,
    busy = (lock, holder) => new FileLockBusyError(`${lock} is held by ${holder}`) }) {
    this.path = file;
    this.waitMs = waitMs;
    this.staleMs = staleMs;
    this.rejudgeMs = rejudgeMs;
    this.unreadableMs = unreadableMs;
    this.io = io;
    this.probe = probe;
    this.now = now;
    this.busy = busy;
  }

  /** Run `work(stillHeld)` holding the lock, and release it after, if it is still ours. */
  hold(work) {
    const lock = this.path;
    this.io.mkdirSync(path.dirname(lock), { recursive: true });
    const token = JSON.stringify({ pid: process.pid, atMs: this.now(), nonce: Math.random().toString(36).slice(2) });
    const deadline = this.now() + this.waitMs;
    // A verdict is re-asked every rejudgeMs: a holder seen alive can die while this start waits,
    // and a verdict cached for the whole wait refused every waiter behind a dead holder.
    let judgedText = null;
    let judgedAt = 0;
    let abandoned = false;
    // EVERY PASS MEETS THE DEADLINE. Only a pass that proved the lock free -- it was gone, or a takeover removed the
    // very lock judged abandoned -- may try again at once, and only FREED_RETRIES times in a row, so a zero wait still
    // takes a dead holder's lock and nothing else can spin (review of ba87799: 930 EISDIR and 15,100 EPERM passes).
    let freedInARow = 0;
    let holder = "unreadable";
    for (;;) {
      try {
        this.io.writeFileSync(lock, token, { flag: "wx" });
        break;
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
      let freed = false;
      try {
        const text = String(this.io.readFileSync(lock, "utf8"));
        const { mtimeMs } = this.io.statSync(lock);
        holder = text;
        if (text !== judgedText || this.now() - judgedAt >= this.rejudgeMs) {
          abandoned = this.#abandoned(text, this.now() - mtimeMs, mtimeMs);
          judgedText = text;
          judgedAt = this.now();
        }
        if (abandoned) {
          freed = this.#takeOver(lock, text);
          judgedText = null;
        }
      } catch (err) {
        // Gone between the create and this read is free. Any other failure to read it is unknown, and waits.
        freed = err?.code === "ENOENT";
      }
      freedInARow = freed ? freedInARow + 1 : 0;
      if (freed && freedInARow <= FREED_RETRIES) continue;
      if (this.now() >= deadline) throw this.busy(lock, holder);
      processes.sleepMs(100);
    }
    try {
      return work(() => this.#holds(lock, token));
    } finally {
      // Only our own lock: after a takeover race another start may hold this path now.
      if (this.#holds(lock, token)) this.io.rmSync(lock, { force: true });
    }
  }

  /**
   * Whether the lock text names a holder that is gone.
   *
   * The holder writes its pid and the moment it took the lock, which identifies it without a start time
   * (see `identify`). A lock with no readable holder at all -- empty, or cut short by a crash between
   * create and write -- is abandoned once it is older than a holder's first instant could leave it.
   */
  #abandoned(text, ageMs, mtimeMs) {
    if (ageMs > this.staleMs) return true;
    let holder;
    try {
      holder = JSON.parse(text);
    } catch {
      holder = null;
    }
    const pid = Number(holder?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return ageMs > this.unreadableMs;
    const state = this.probe.liveness(pid);
    if (state === "gone") return true;
    if (state !== "alive") return false;
    // Alive: freed only when its pid now belongs to a later process, which takes a start time that was READ. A failed
    // query (null) or a pid missing from the answer is unknown, never gone (review of ba87799).
    const times = this.probe.startTimes([pid], { strict: true });
    if (!times?.has(pid)) return false;
    // The holder's moment and the lock's mtime are wall-clock; a start time is anchored (`anchorOffsetMs`).
    const offsetMs = this.probe.anchorOffsetMs?.() ?? 0;
    return processes.identify({ seenAliveAtMs: Number(holder.atMs) || mtimeMs }, { alive: true, startedAt: times.get(pid), offsetMs }) === "reused";
  }

  /**
   * Whether this holder still holds the lock. A MISSING lock is asked about again for a moment first: a
   * waiter's takeover renames the lock away and puts back one it should not have taken, and a holder that
   * read the gap as lost would give up after it had already done what it held the lock for.
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
   * Remove an abandoned lock without removing a fresh one; true when the judged lock was removed. The lock is
   * RENAMED away, which only one waiter can do. It is deleted only when it was READ and is the very lock judged
   * abandoned. Anything else -- another waiter's fresh lock, or one this could not read -- is put back without
   * replacing whatever holds the path now, and if it cannot be put back it is kept, never discarded (review of
   * ba87799: a failed read was taken for a match, and a live holder's token deleted).
   *
   * A window remains between that rename and the put-back in which a third waiter can take the path.
   * Two holders are then possible, so a holder re-reads the lock (`stillHeld`) just before the write it
   * must not share, and stops when it no longer holds it.
   */
  #takeOver(lock, judgedText) {
    const moved = `${lock}.${process.pid}.${this.now()}.${Math.random().toString(36).slice(2)}.abandoned`;
    try {
      this.io.renameSync(lock, moved);
    } catch {
      return false;
    }
    let text = null;
    try {
      text = String(this.io.readFileSync(moved, "utf8"));
    } catch {
      // Unknown: never taken for the judged lock.
    }
    if (text === judgedText) {
      this.io.rmSync(moved, { force: true });
      return true;
    }
    try {
      // A hard link creates the path only if nothing holds it now, and needs no read of what is being put back.
      this.io.linkSync(moved, lock);
      this.io.rmSync(moved, { force: true });
    } catch {
      // Somebody holds the path again, or it could not be linked: the moved lock stays where it is.
    }
    return false;
  }
}
