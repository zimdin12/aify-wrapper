// Is a recorded pid still the process that was recorded, and how to end one and everything it started.
//
// PID REUSE IS THE HAZARD. A pid written down before a crash can belong to something unrelated by the
// time anyone reads it, and ending a stranger's process is far worse than the leftover being collected.
// So a pid is only ever called OURS when it is alive AND the OS reports the start time that was recorded
// (or, with none recorded, a start no later than the moment it was seen alive). Anything this host cannot
// decide is UNKNOWN, never ours.
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

/**
 * How far an OS-reported start time may sit from the recorded one and still be the same process.
 *
 * A recorded start comes from the same probe that reads it back, so the only slack needed is a
 * resolution: `ps lstart` truncates to the second. Measured 2026-09-15 on Windows, hermes' own record
 * of a live process (psutil) and CIM differed by 0.4 ms. It was 30 s, which let a pid handed to another
 * agent's runtime within half a minute of our process dying read as ours.
 */
export const START_TIME_TOLERANCE_MS = 2_000;

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

/**
 * `<pid> <start>` lines into pid -> epoch ms: the start is ISO-8601 UTC from the CIM query below, or
 * `ps -o lstart=` text (local time, to the second). A line whose start does not parse is skipped.
 */
export function parseStartedAtLines(text) {
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
 *
 * `strict` answers null when the probe itself failed -- a query that timed out or exited non-zero -- so a
 * caller deciding that a process has GONE is never handed a failed probe's empty answer as proof.
 */
export function startTimes(pids, { platform = process.platform, run = spawnSync, readFile = fs.readFileSync, strict = false } = {}) {
  const wanted = validPids(pids);
  if (!wanted.length) return new Map();
  const failed = strict ? null : new Map();
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
      // CIM exits 0 when no pid matched; a timeout or a failure leaves `error` or a non-zero status.
      if (!res || res.error || res.status !== 0) return failed;
      return parseStartedAtLines(res.stdout);
    }
    const res = run("ps", ["-o", "pid=,lstart=", "-p", wanted.join(",")], { encoding: "utf8", timeout: 5_000 });
    // ps exits 1 when none of the pids exist, which is an answer, not a failure.
    if (!res || res.error || (res.status !== 0 && res.status !== 1)) return failed;
    return parseStartedAtLines(res.stdout);
  } catch {
    return failed;
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
 * What a recorded process is now: `ours`, `gone`, `reused` (alive, but the pid belongs to something
 * else) or `unknown` (alive, and nothing to compare).
 *
 * Two ways to be ours. With a recorded start time: the OS reports the same one. Without one -- the probe
 * failed when the entry was written -- `seenAliveAtMs` still decides it: the pid was alive at that
 * moment, and pids are unique among live processes, so a process holding it now that started no later
 * than that moment IS the one that was seen. A later start is a reused pid.
 */
export function identify(entry, { alive, startedAt }) {
  if (!alive) return "gone";
  if (!startedAt) return "unknown";
  const recorded = Number(entry?.startedAtMs);
  if (recorded) return Math.abs(startedAt - recorded) <= START_TIME_TOLERANCE_MS ? "ours" : "reused";
  const seen = Number(entry?.seenAliveAtMs);
  if (seen) return startedAt <= seen ? "ours" : "reused";
  return "unknown";
}

/** True for a pid no tree-kill may ever target: nothing, init, this process, or its parent. */
export function isProtected(pid, { self = process.pid, parent = process.ppid } = {}) {
  return !Number.isInteger(pid) || pid <= 1 || pid === self || pid === parent;
}

/** `<pid> <ppid> <start>` lines into rows; the start is ISO on Windows and `lstart` text from ps. */
export function parseProcessTable(text) {
  const rows = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const at = match ? Date.parse(match[3]) : NaN;
    if (match && Number.isFinite(at)) rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), startedAtMs: at });
  }
  return rows;
}

/** The parent pid (field 4) of `/proc/<pid>/stat` text, or null. */
function parseLinuxParent(statText) {
  const close = String(statText || "").lastIndexOf(")");
  const ppid = close === -1 ? NaN : Number(String(statText).slice(close + 1).trim().split(/\s+/)[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/**
 * Every process this host lists, as pid -> {pid, ppid, startedAtMs}, or null when it cannot be listed.
 * One call: on Windows the whole table is one CIM query.
 */
export function processTable({ platform = process.platform, run = spawnSync, readFile = fs.readFileSync, readDir = fs.readdirSync } = {}) {
  try {
    if (platform === "linux") {
      const procStat = String(readFile("/proc/stat", "utf8"));
      const rows = new Map();
      for (const name of readDir("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = String(readFile(`/proc/${name}/stat`, "utf8"));
          // A zombie has exited; listing it would read a stopped process as still running.
          if (["Z", "X"].includes(parseLinuxState(stat))) continue;
          const startedAtMs = parseLinuxStartedAt(stat, procStat);
          const ppid = parseLinuxParent(stat);
          if (startedAtMs && ppid !== null) rows.set(Number(name), { pid: Number(name), ppid, startedAtMs });
        } catch {
          // Gone between listing and reading.
        }
      }
      return rows.size ? rows : null;
    }
    const res = platform === "win32"
      ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { "{0} {1} {2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString("o") } }`],
      { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
      : run("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    // A query that timed out or failed can still have printed part of the table, and a partial table is
    // worse than none: missing rows shorten an ancestry (an ancestor could be stopped) and drop children
    // (a stop "succeeds" with the runtime still running). Measured: a CIM query cut off at 450 ms printed
    // 139 of 838 rows.
    if (!res || res.error || res.status !== 0) return null;
    const rows = parseProcessTable(res.stdout);
    return rows.size ? rows : null;
  } catch {
    return null;
  }
}

/**
 * `pid` and every parent above it that the table still lists. The walk stops at a parent that started
 * AFTER its child: Windows keeps a dead parent's id on the child, and a process now holding that id is
 * not an ancestor (`descendants` applies the same rule downwards).
 */
export function ancestors(pid, table) {
  const chain = new Set();
  let at = pid;
  while (Number.isInteger(at) && at > 0 && !chain.has(at)) {
    chain.add(at);
    const row = table?.get(at);
    const parent = table?.get(row?.ppid);
    if (!row || !parent || parent.startedAtMs > row.startedAtMs) {
      // An unlisted parent is still named, so the caller's own direct parent is spared even when the
      // table missed it; nothing above an unverifiable link is.
      if (row && !parent && Number.isInteger(row.ppid) && row.ppid > 0) chain.add(row.ppid);
      break;
    }
    at = parent.pid;
  }
  return chain;
}

/**
 * Every process started by `pid`, however deep. A PARENT ID IS NOT PROOF OF PARENTAGE: Windows never
 * clears a child's ParentProcessId when its parent exits, so a process whose parent died long ago names
 * whatever now holds that pid. A child that started before its supposed parent is one of those, and is
 * not followed.
 *
 * Nothing in `boundaries`, and nothing below it, is included: a process somebody else answers for (another
 * agent's launcher, started from this agent's shell) is not this tree's to end.
 */
export function descendants(pid, table, boundaries = new Set()) {
  const found = [];
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length) {
    // Shifted first: `table?.get(queue.shift())` skips the shift when there is no table, and never ends.
    const next = queue.shift();
    const parent = table?.get(next);
    if (!parent) continue;
    for (const row of table.values()) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || row.startedAtMs < parent.startedAtMs || boundaries.has(row.pid)) continue;
      seen.add(row.pid);
      found.push(row.pid);
      queue.push(row.pid);
    }
  }
  return found;
}

/**
 * End `pid` and its descendants. Never throws; returns whether an attempt was made.
 *
 * The tree is read from the process table rather than left to `taskkill /T` or a process-group signal:
 * `/T` follows stale parent ids (above), and a group signal misses a launcher that is not a group leader,
 * which leaves its runtime running while the launcher dies. When the table cannot be read, only `pid`
 * itself is ended: an unreadable table never widens a kill. `boundaries` are subtrees left standing (see
 * `descendants`).
 */
export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill, protect = {}, table, spare = [], boundaries = [] } = {}) {
  if (isProtected(pid, protect)) return false;
  const rows = table === undefined ? processTable({ platform, run }) : table;
  // The caller and everything above it, plus anything the caller names in `spare`. Ending an ancestor
  // ends the caller, and on POSIX a group signal to an ancestor that leads the caller's group reaches
  // the caller too.
  const spared = new Set([...ancestors(protect.self ?? process.pid, rows), ...spare]);
  if (spared.has(pid)) return false;
  const targets = [pid, ...descendants(pid, rows, new Set(boundaries))].filter((target) => !isProtected(target, protect) && !spared.has(target));
  if (platform === "win32") {
    try {
      run("taskkill", ["/F", ...targets.flatMap((target) => ["/PID", String(target)])], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }
  let any = false;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const target of [-pid, ...targets]) {
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
