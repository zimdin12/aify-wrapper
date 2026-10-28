// One holder at a time across processes, for work on a shared file: `<path>` created exclusively, holding the
// holder's pid and the moment it took it.
//
// A HOLDER THAT IS GONE DOES NOT KEEP IT. A waiter re-judges the holder every `rejudgeMs` and takes over a lock whose
// holder is dead, reused (identify), unnamed for longer than `unreadableMs`, or older than `staleMs` whatever its
// holder. Moved here from AgentLease (lib/agent-lease.mjs), which used it alone, when the hermes config change an
// install leaves pending needed the same lock (lib/hermes-pending-config.mjs).

import fs from "node:fs";
import path from "node:path";
import * as processes from "./process-identity.mjs";

export class FileLockBusyError extends Error {}

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
        if (text !== judgedText || this.now() - judgedAt >= this.rejudgeMs) {
          abandoned = this.#abandoned(text, this.now() - mtimeMs, mtimeMs);
          judgedText = text;
          judgedAt = this.now();
        }
        if (abandoned) {
          this.#takeOver(lock, text);
          judgedText = null;
          continue;
        }
        if (this.now() >= deadline) throw this.busy(lock, text);
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
    if (!this.probe.isAlive(pid)) return true;
    const times = this.probe.startTimes([pid], { strict: true });
    if (!times) return false;
    // The holder's moment and the lock's mtime are wall-clock; a start time is anchored (`anchorOffsetMs`).
    const offsetMs = this.probe.anchorOffsetMs?.() ?? 0;
    const state = processes.identify({ seenAliveAtMs: Number(holder.atMs) || mtimeMs }, { alive: times.has(pid), startedAt: times.get(pid), offsetMs });
    return state === "gone" || state === "reused";
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
   * Remove an abandoned lock without removing a fresh one. The lock is RENAMED away, which only one
   * waiter can do; if what was renamed is not the lock that was judged abandoned, another waiter
   * already took over and wrote its own, and that one is put back.
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
