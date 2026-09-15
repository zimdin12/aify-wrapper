// Is a recorded pid still the process that was recorded, and how to end one and everything it started.
//
// PID REUSE IS THE HAZARD. A pid written down before a crash can belong to something unrelated by the
// time anyone reads it, and ending a stranger's process is far worse than the leftover being collected.
// So a pid is only ever called OURS when it is alive AND the OS reports the start time that was recorded.
// A start time this host cannot read makes the answer UNVERIFIED, never ours.
//
// ONE PROBE PER QUESTION, batched. On Windows the start time comes from CIM through PowerShell, which
// costs about 575 ms a call on this host (measured 2026-09-15), so every pid a decision needs is asked
// in one call rather than one call each.
//
// aify-env answers part of the same question in lib/orphan-reap.mjs and lib/kill-tree.mjs. aify-wrapper
// does not depend on aify-env, so this is a second implementation, recorded in the one-live-instance
// plan so the copy is known rather than discovered.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** How far an OS-reported start time may sit from the recorded one and still be the same process. */
export const START_TIME_TOLERANCE_MS = 30_000;

/** Ticks per second procfs reports `starttime` in; procfs fixes it at 100. */
const LINUX_USER_HZ = 100;

/**
 * A Linux process's start in epoch ms from the text of `/proc/<pid>/stat` and `/proc/stat`, or null.
 * Field 22 is ticks since boot; the executable name in field 2 may hold spaces and parentheses, so the
 * fields are counted from after the LAST `)`.
 */
export function parseLinuxStartedAt(statText, procStatText) {
  const close = String(statText || "").lastIndexOf(")");
  if (close === -1) return null;
  const ticks = Number(String(statText).slice(close + 1).trim().split(/\s+/)[19]);
  const boot = /^btime\s+(\d+)/m.exec(String(procStatText || ""));
  if (!Number.isFinite(ticks) || ticks < 0 || !boot) return null;
  return (Number(boot[1]) + ticks / LINUX_USER_HZ) * 1000;
}

/** The state letter of `/proc/<pid>/stat` (field 3), or null. */
export function parseLinuxState(statText) {
  const close = String(statText || "").lastIndexOf(")");
  if (close === -1) return null;
  return String(statText).slice(close + 1).trim().split(/\s+/)[0] || null;
}

/** `<pid> <ISO-8601 UTC>` lines, as the CIM query below prints them, into pid -> epoch ms. */
export function parseWindowsStartedAt(text) {
  const found = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    const at = match ? Date.parse(match[2]) : NaN;
    if (match && Number.isFinite(at)) found.set(Number(match[1]), at);
  }
  return found;
}

/** `ps -o pid=,lstart=` lines into pid -> epoch ms. lstart is local time to the second. */
export function parsePsStartedAt(text) {
  const found = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    const at = match ? Date.parse(match[2]) : NaN;
    if (match && Number.isFinite(at)) found.set(Number(match[1]), at);
  }
  return found;
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function validPids(pids) {
  return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * The start time of every LIVE pid among `pids`, as a Map. A pid missing from the map is either gone or
 * unreadable; `isAlive` tells those apart.
 */
export function startTimes(pids, { platform = process.platform, run = spawnSync, readFile = fs.readFileSync } = {}) {
  const wanted = validPids(pids);
  if (!wanted.length) return new Map();
  try {
    if (platform === "linux") {
      const procStat = String(readFile("/proc/stat", "utf8"));
      const found = new Map();
      for (const pid of wanted) {
        try {
          const at = parseLinuxStartedAt(String(readFile(`/proc/${pid}/stat`, "utf8")), procStat);
          if (at) found.set(pid, at);
        } catch {
          // Gone, or not ours to read: absent either way.
        }
      }
      return found;
    }
    if (platform === "win32") {
      const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
      const res = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString("o") }`],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      return parseWindowsStartedAt(res.stdout);
    }
    const res = run("ps", ["-o", "pid=,lstart=", "-p", wanted.join(",")], { encoding: "utf8", timeout: 5_000 });
    return parsePsStartedAt(res.stdout);
  } catch {
    return new Map();
  }
}

/**
 * Whether `pid` is a running process. A ZOMBIE IS NOT: on Linux a killed process whose parent has not
 * reaped it keeps its /proc entry and still answers `kill(pid, 0)`, so a stopped launcher read as alive
 * until its parent waited -- measured under WSL 2026-09-15, where every replace was refused as
 * could-not-stop. Its state letter says Z (or X), which is read first.
 */
export function isAlive(pid, { platform = process.platform, kill = process.kill, readFile = fs.readFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "linux") {
    try {
      const state = parseLinuxState(String(readFile(`/proc/${pid}/stat`, "utf8")));
      if (state === "Z" || state === "X") return false;
    } catch {
      return false;
    }
  }
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and belongs to somebody else.
    return err?.code === "EPERM";
  }
}

/**
 * What a recorded process is now: `ours` (alive, same start), `gone`, `reused` (alive, a different
 * start: the pid belongs to something else) or `unverified` (alive, no start time to compare).
 */
export function identify(entry, { alive, startedAt }) {
  if (!alive) return "gone";
  const recorded = Number(entry?.startedAtMs);
  if (!recorded || !startedAt) return "unverified";
  return Math.abs(startedAt - recorded) <= START_TIME_TOLERANCE_MS ? "ours" : "reused";
}

/** True for a pid no tree-kill may ever target: nothing, init, this process, or its parent. */
export function isProtected(pid, { self = process.pid, parent = process.ppid } = {}) {
  return !Number.isInteger(pid) || pid <= 1 || pid === self || pid === parent;
}

/**
 * End `pid` and its descendants. Never throws; returns whether an attempt was made.
 * Windows: `taskkill /T /F`. POSIX: SIGTERM to the process group and the pid, then SIGKILL.
 */
export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill, protect = {} } = {}) {
  if (isProtected(pid, protect)) return false;
  if (platform === "win32") {
    try {
      run("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }
  let any = false;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const target of [-pid, pid]) {
      try {
        kill(target, signal);
        any = true;
      } catch {
        // Not a group leader, or already gone.
      }
    }
    // Half a second to exit cleanly before SIGKILL; a synchronous wait, since every caller is a CLI step.
    if (signal === "SIGTERM" && any) sleepMs(500);
  }
  return any;
}
