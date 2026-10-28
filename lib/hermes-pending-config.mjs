// The hermes config change an install leaves pending, applied by the first hermes start that finds no hermes running.
//
// WHY PENDING. Hermes has no per-session MCP flag, so the session servers go into the user's hermes config, and a
// RUNNING hermes reloads mcp_servers the moment their content changes (lib/hermes-config-cli.mjs). An install made
// while hermes agents ran reloaded their servers mid-session, so the operator held hermes installs until a restart
// (2026-10-28: "can we set it up so when i restart next time then it is correct for hermes"). An install now records
// the change, applies it at once only when no hermes runs, and otherwise leaves it to the next start.
//
// THE MARKER NAMES THE REGISTRY, NEVER THE ENTRIES. An entry can carry a service's key; the step builds them when it
// runs (lib/hermes-config-cli.mjs), from the registry and the keys as they are then.
//
// ONE APPLIER, AND ONLY INTO A QUIET HOST. A start takes the lock (lib/file-lock.mjs), reads the marker again, and
// applies only when no process runs hermes. At "restart all" several starts arrive together: the others wait at the
// lock as launchers and node, which are not hermes and do not count, and none starts its hermes until the holder
// releases, so the starts queued behind an apply launch with it in place (the restart-all case, 2026-10-28).
// A hermes started some other way between the scan and the write is not seen: that is the window this cannot close.

import fs from "node:fs";
import path from "node:path";

import { FileLock, FileLockBusyError } from "./file-lock.mjs";
import { hermesRoots, unexpandedHomeProblem } from "./hermes-config-install.mjs";

/** What `apply` came to, and the exit status the command gives each. */
export const OUTCOMES = Object.freeze({ none: 0, applied: 0, deferred: 75, failed: 78 });

/**
 * How long a start waits behind another start's apply, and how old a held lock may grow. The step makes one bounded
 * hermes call per server and two more (lib/hermes-config-cli.mjs), each a few seconds when hermes is warm.
 */
const APPLY_LOCK_MS = 12 * 60_000;

/** The marker's place under a home: `~/.aify/hermes-config-pending.json`. */
export function pendingMarkerPath(home) {
  return path.join(home, ".aify", "hermes-config-pending.json");
}

const PYTHON = /^python[0-9.]*w?$/;
/** Python's options that take the next word as their value (`python --help`), so it is never read as the script. */
const PYTHON_VALUE_OPTIONS = new Set(["-W", "-X", "--check-hash-based-pycs"]);
const base = (token) => String(token ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");

/**
 * Whether a listed process runs hermes itself: `yes`, `no`, or `unknown`. PURE. A row is the process table's
 * (`processTable({commands: true})`): its `image` and its `argv` as a list, either null when unreadable.
 *
 * MATCHED BY WHAT IT RUNS, as lib/hermes-prior-runs.mjs matches: the `hermes` program, or a python whose script,
 * module or code is hermes. A launcher (`bash hermes-aify`), the delivery loop (`node hermes-managed-host.js`), a tool
 * hermes started, or anything whose arguments only mention hermes is not hermes. Every hermes measured on Windows
 * (2026-10-28) is a chain starting at the `hermes.exe` program; the python layers under it count too.
 *
 * ONLY POSITIVE EVIDENCE OF QUIET (review of ba87799). The program is the OS's image name, so a path with a space
 * cannot hide it. A python, or a process with no readable image, whose argv cannot be read is UNKNOWN. A process whose
 * image is plainly another program is `no` even when its argv is unreadable: on Windows another user's processes
 * all have unreadable command lines, and a gate that waited on them would never open. KNOWN ISSUE: a hermes running
 * under an image that is neither `hermes` nor a python, with an unreadable command line, is missed.
 */
export function runsHermes(row) {
  const image = row?.image ?? null;
  const argv = Array.isArray(row?.argv) ? row.argv : null;
  if (image === "hermes") return "yes";
  if (image !== null && !PYTHON.test(image)) return "no";
  if (!argv) return "unknown";
  if (image === null) {
    const program = base(argv[0]);
    if (program === "hermes") return "yes";
    if (!PYTHON.test(program)) return "no";
  }
  return pythonRunsHermes(argv.slice(1));
}

/** What a python's arguments run, as python reads them: options, then `-c` code, `-m` module, or a script. PURE. */
function pythonRunsHermes(args) {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (word === "-") return "unknown";
    if (!word.startsWith("-")) return ["hermes", "hermes-script.py"].includes(base(word)) ? "yes" : "no";
    if (PYTHON_VALUE_OPTIONS.has(word)) { at += 1; continue; }
    if (word.startsWith("--")) continue;
    // A cluster of one-letter flags (`-IBu`); the first of c, m, W or X ends it, its value attached or the next word.
    const flags = word.slice(1);
    const stop = flags.search(/[cmWX]/);
    if (stop === -1) continue;
    const value = flags.slice(stop + 1) || args[++at];
    if (flags[stop] === "c") return value === undefined ? "unknown" : /hermes/i.test(value) ? "yes" : "no";
    if (flags[stop] === "m") return value === undefined ? "unknown" : /^hermes_cli(\.|$)/.test(value) ? "yes" : "no";
  }
  return "no";
}

/** PURE. The pids of a process table that run hermes, and those it cannot tell about, each ascending. */
export function hermesProcesses(table) {
  const running = [];
  const unknown = [];
  for (const row of table.values()) {
    const verdict = runsHermes(row);
    if (verdict === "yes") running.push(row.pid);
    else if (verdict === "unknown") unknown.push(row.pid);
  }
  return { running: running.sort((a, b) => a - b), unknown: unknown.sort((a, b) => a - b) };
}

/**
 * The hermes config a process with this environment writes, the way hermes resolves its home: HERMES_HOME as written,
 * else the platform's default root (lib/hermes-config-install.mjs `hermesRoots`). Null when HERMES_HOME holds ~ or
 * variable syntax hermes expands and this does not (`unexpandedHomeProblem`). PURE.
 */
export function hermesConfigTarget({ env, platform, homedir }) {
  if (unexpandedHomeProblem(env) !== null) return null;
  const [native] = hermesRoots({ env: { ...env, HERMES_HOME: "" }, platform, homedir, join: path.join, dirname: path.dirname, basename: path.basename });
  return path.resolve(env.HERMES_HOME?.trim() || native, "config.yaml");
}

/** Whether two config targets are one file: case-insensitively on Windows, where the file system is. PURE. */
export function sameTarget(a, b, platform = process.platform) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The change an install recorded, under one marker file. */
export class PendingHermesConfig {
  constructor({ marker, io = fs, now = () => new Date().toISOString(), lockMs = APPLY_LOCK_MS, lock = {} }) {
    this.marker = marker;
    this.io = io;
    this.now = now;
    this.lock = new FileLock({ path: `${marker}.lock`, waitMs: lockMs, staleMs: lockMs, io, ...lock });
  }

  /**
   * Record that `registry`'s servers are to be written into the hermes config at `target` (`hermesConfigTarget`); a
   * later install's record replaces an earlier one. UNDER THE APPLY LOCK, so a record never lands between an apply's
   * last comparison and its removal of the marker (review of ba87799). Throws FileLockBusyError when an apply holds
   * the lock past the wait.
   */
  record(registry, target) {
    if (typeof target !== "string" || target === "") throw new Error("a pending hermes config change needs the config it is for");
    const text = `${JSON.stringify({ version: 1, registry: path.resolve(registry), target, recordedAt: this.now() })}\n`;
    return this.lock.hold(() => {
      const temp = `${this.marker}.${process.pid}.tmp`;
      this.io.writeFileSync(temp, text);
      this.io.renameSync(temp, this.marker);
      return text;
    });
  }

  /** `{state: "none"}`, `{state: "pending", registry, target, recordedAt, text}`, or `{state: "unreadable", problem}`. */
  read() {
    let text;
    try {
      text = String(this.io.readFileSync(this.marker, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { state: "none" };
      return { state: "unreadable", problem: `${this.marker} cannot be read (${error.code ?? error.message})` };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const fields = [body?.registry, body?.target, body?.recordedAt];
    if (body?.version !== 1 || !fields.every((field) => typeof field === "string" && field !== "")) {
      return { state: "unreadable", problem: `${this.marker} is not a pending hermes config record; remove it and re-run the installer` };
    }
    return { state: "pending", registry: body.registry, target: body.target, recordedAt: body.recordedAt, text };
  }

  /**
   * Apply the recorded change if it is for this start's hermes config and this host is quiet: `{outcome, detail}`,
   * an outcome from OUTCOMES. A change recorded for another config is left alone, named, for a start of that home.
   *
   * @param {() => Map<number, {pid: number, image: string|null, argv: string[]|null}> | null} scan  the process table,
   *   null when unreadable
   * @param {(registry: string) => {ok: boolean, detail: string}} step  the installer's hermes step
   * @param {string|null} target  the config this start's hermes uses (`hermesConfigTarget`), null when unresolvable
   */
  apply({ scan, step, target, platform = process.platform }) {
    const first = this.read();
    if (first.state === "none") return { outcome: "none", detail: "nothing pending" };
    if (first.state === "pending" && !sameTarget(first.target, target, platform)) return elsewhere(first, target);
    try {
      return this.lock.hold((stillHeld) => this.#applyHeld({ scan, step, target, platform, stillHeld }));
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) throw error;
      return { outcome: "deferred", detail: `another start still holds ${this.lock.path}; this one starts without waiting longer` };
    }
  }

  #applyHeld({ scan, step, target, platform, stillHeld }) {
    const pending = this.read();
    if (pending.state === "none") return { outcome: "none", detail: "applied by another start" };
    if (pending.state === "unreadable") return { outcome: "failed", detail: pending.problem };
    if (!sameTarget(pending.target, target, platform)) return elsewhere(pending, target);
    const recorded = `the change an install recorded at ${pending.recordedAt}`;
    const table = scan();
    if (!table) return { outcome: "deferred", detail: `${recorded} waits: this host's processes cannot be listed, so a running hermes cannot be ruled out` };
    const { running, unknown } = hermesProcesses(table);
    if (running.length) {
      return { outcome: "deferred", detail: `${recorded} waits: hermes is running here (pid ${running.join(", ")}); the first hermes start that finds none applies it` };
    }
    if (unknown.length) {
      return { outcome: "deferred", detail: `${recorded} waits: what pid ${unknown.join(", ")} runs cannot be read, so it may be hermes` };
    }
    if (!stillHeld()) return { outcome: "deferred", detail: `${recorded} waits: another start took the lock` };
    const result = step(pending.registry);
    if (!result.ok) return { outcome: "failed", detail: `${recorded} was not applied, and stays pending: ${result.detail}` };
    // Only the record that was applied. A newer one cannot land from here to the removal: record() waits on this lock.
    if (this.read().text === pending.text) this.io.rmSync(this.marker, { force: true });
    return { outcome: "applied", detail: `${recorded} is applied` };
  }
}

/** A recorded change this start leaves alone: it is for another hermes config, or this start's cannot be resolved. */
function elsewhere(pending, target) {
  const here = target ?? "unresolvable here (HERMES_HOME holds ~ or variable syntax)";
  return { outcome: "deferred", detail: `a change an install recorded at ${pending.recordedAt} is pending for ${pending.target}; this start's hermes config is ${here}, so it is left for a start of that one` };
}
