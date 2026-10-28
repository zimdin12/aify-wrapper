#!/usr/bin/env node
// lib/file-lock.mjs frees a held lock only on positive evidence that its holder has ended, and every wait ends at its
// deadline (review of ba87799). The ten specimens are the reviewer's: five controls, and the five adverse cases that
// took a fresh holder's lock, discarded one, or spun past a zero wait. AgentLease shares this lock; its own cases are
// in agent-lease.test.js.
//
// Every lock is a temp file; the faults are injected through the lock's own io and probe.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FileLock, FileLockBusyError } from "../lib/file-lock.mjs";
import * as processes from "../lib/process-identity.mjs";
import { liveness } from "../lib/process-identity.mjs";

const failing = (code) => () => { throw Object.assign(new Error(code), { code }); };
const proc = (state) => () => `1 (x) ${state} 0`;

test("liveness: gone only when the OS says so, alive when it answers, unknown for anything it cannot tell", () => {
  assert.equal(liveness(process.pid), "alive");
  assert.equal(liveness(12, { platform: "win32", kill: () => true }), "alive");
  assert.equal(liveness(12, { platform: "win32", kill: failing("EPERM") }), "alive", "EPERM: it exists, and is someone else's");
  assert.equal(liveness(12, { platform: "win32", kill: failing("ESRCH") }), "gone");
  assert.equal(liveness(12, { platform: "win32", kill: failing("EINVAL") }), "unknown");
  for (const pid of [2147483648, 0, -1, 1.5, Number.NaN]) assert.equal(liveness(pid), "unknown", String(pid));
  assert.equal(liveness(12, { platform: "linux", kill: () => true, readFile: proc("Z") }), "gone", "a zombie has exited");
  assert.equal(liveness(12, { platform: "linux", kill: () => true, readFile: failing("ENOENT") }), "gone");
  assert.equal(liveness(12, { platform: "linux", kill: () => true, readFile: failing("EACCES") }), "alive", "an unreadable /proc entry defers to the signal");
});

/**
 * A lock file holding `holder`, and a FileLock on it with a zero wait. `probe` answers for the holder's pid; `io`
 * overrides individual fs calls, with `swapBeforeRename` putting a fresh live holder's token in place just before the
 * judged lock is renamed away (the reviewer's moved-file cases).
 */
function specimen({ holder, alive = "alive", startedAt, io: faults = {}, swapBeforeRename = false, directory = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-file-lock-"));
  const lock = path.join(dir, "x.lock");
  const live = JSON.stringify({ pid: process.pid, atMs: Date.now(), nonce: "live" });
  if (directory) fs.mkdirSync(lock);
  else fs.writeFileSync(lock, JSON.stringify(holder));
  const seen = { reads: 0, renames: 0 };
  const io = { ...fs, ...faults };
  io.readFileSync = (file, ...rest) => {
    if (String(file) === lock) seen.reads += 1;
    return (faults.readFileSync ?? fs.readFileSync)(file, ...rest);
  };
  io.renameSync = (from, to) => {
    if (String(from) === lock) {
      seen.renames += 1;
      if (swapBeforeRename && seen.renames === 1) {
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, live, { flag: "wx" });
      }
    }
    return (faults.renameSync ?? fs.renameSync)(from, to);
  };
  const probe = { ...processes, liveness: () => alive, startTimes: () => startedAt };
  const take = () => {
    let ran = false;
    try {
      new FileLock({ path: lock, waitMs: 0, staleMs: 60_000, io, probe }).hold(() => { ran = true; });
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) throw error;
    }
    return ran;
  };
  const left = () => (fs.existsSync(lock) && fs.statSync(lock).isFile() ? fs.readFileSync(lock, "utf8") : null);
  return { take, left, seen, live, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const fresh = (pid) => ({ pid, atMs: Date.now(), nonce: "holder" });

test("CONTROLS: a free path is taken; a dead holder's lock is taken at a zero wait; a live, identified holder keeps it", () => {
  const none = specimen({ holder: fresh(4242), alive: "gone" });
  try {
    fs.rmSync(path.join(none.dir, "x.lock"));
    assert.equal(none.take(), true, "healthy: nobody held it");
  } finally { none.cleanup(); }
  const dead = specimen({ holder: fresh(4242), alive: "gone" });
  try {
    assert.equal(dead.take(), true, "dead: ESRCH is positive evidence");
  } finally { dead.cleanup(); }
  for (const [name, startedAt] of [["live-null", null], ["live-identified", new Map([[4242, Date.now() - 60_000]])]]) {
    const holder = fresh(4242);
    const s = specimen({ holder, startedAt });
    try {
      assert.equal(s.take(), false, name);
      assert.equal(s.left(), JSON.stringify(holder), `${name}: the holder's lock was changed`);
    } finally { s.cleanup(); }
  }
  const reused = specimen({ holder: fresh(4242), startedAt: new Map([[4242, Date.now() + 60_000]]) });
  try {
    assert.equal(reused.take(), true, "a readable start after the lock was taken is a reused pid");
  } finally { reused.cleanup(); }
});

test("a holder whose pid cannot be probed, or whose start time is missing from the answer, keeps its lock", () => {
  const badPid = fresh(2147483648);
  const unprobeable = specimen({ holder: badPid, alive: liveness(2147483648) });
  try {
    assert.equal(unprobeable.take(), false, "bad-pid: ERR_INVALID_ARG_TYPE is not ESRCH");
    assert.equal(unprobeable.left(), JSON.stringify(badPid));
  } finally { unprobeable.cleanup(); }
  const holder = fresh(4242);
  const empty = specimen({ holder, startedAt: new Map() });
  try {
    assert.equal(empty.take(), false, "live-empty: a start time not read is not a start time that differs");
    assert.equal(empty.left(), JSON.stringify(holder));
  } finally { empty.cleanup(); }
});

test("a moved lock is deleted only when it was read and is the one judged; otherwise it goes back, never discarded", () => {
  for (const [name, faults] of [["moved-readable", {}], ["moved-unreadable", { readFileSync: (file, ...rest) => {
    if (String(file).endsWith(".abandoned")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return fs.readFileSync(file, ...rest);
  } }]]) {
    const s = specimen({ holder: fresh(4242), alive: "gone", io: faults, swapBeforeRename: true });
    try {
      assert.equal(s.take(), false, `${name}: a fresh live holder's lock was used`);
      assert.equal(s.left(), s.live, `${name}: the live holder's token is not at the lock path`);
      const kept = fs.readdirSync(s.dir).filter((name) => name.endsWith(".abandoned"));
      assert.deepEqual(kept, [], `${name}: a put-back left a copy behind`);
    } finally { s.cleanup(); }
  }
});

test("a lock it cannot read, or cannot move, ends at the deadline instead of spinning past it", () => {
  const directory = specimen({ directory: true });
  try {
    const started = Date.now();
    assert.equal(directory.take(), false, "directory: EISDIR is unknown, not free");
    assert.ok(directory.seen.reads <= 2 && Date.now() - started < 2_000, `directory: ${directory.seen.reads} reads at a zero wait`);
  } finally { directory.cleanup(); }
  const deadHolder = fresh(4242);
  const denied = specimen({ holder: deadHolder, alive: "gone", io: { renameSync: failing("EPERM") } });
  try {
    const started = Date.now();
    assert.equal(denied.take(), false, "rename-denied: a takeover that failed is not a free lock");
    assert.ok(denied.seen.renames <= 2 && Date.now() - started < 2_000, `rename-denied: ${denied.seen.renames} renames at a zero wait`);
    assert.equal(denied.left(), JSON.stringify(deadHolder), "the lock it could not move was changed");
  } finally { denied.cleanup(); }
});
