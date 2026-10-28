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

/** A command line as its argv, quotes removed. PURE. */
function argv(commandLine) {
  return (String(commandLine || "").match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^(["'])(.*)\1$/, "$2"));
}

const base = (token) => String(token || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");

/**
 * Whether a process runs hermes itself: the `hermes` program, or a python whose script is `hermes`. PURE.
 *
 * MATCHED BY WHAT IT RUNS, as lib/hermes-prior-runs.mjs matches. A launcher (`bash hermes-aify`), the delivery loop
 * (`node hermes-managed-host.js`), a tool hermes started, or anything whose arguments only mention hermes is not hermes.
 * Every hermes measured on Windows (2026-10-28) is a chain that starts at the `hermes.exe` program; the python layers
 * under it match or not, and the chain counts either way.
 */
export function runsHermes(commandLine) {
  const args = argv(commandLine);
  const program = base(args[0]);
  if (program === "hermes") return true;
  if (!/^python[0-9.]*w?$/.test(program)) return false;
  let at = 1;
  while (args[at]?.startsWith("-")) {
    if (args[at] === "-c") return false;
    if (args[at] === "-m") return /^hermes_cli(\.|$)/.test(args[at + 1] ?? "");
    at += 1;
  }
  return base(args[at]) === "hermes";
}

/** PURE. The pids in a process table (`processTable({commands: true})`) that run hermes, ascending. */
export function hermesProcesses(table) {
  return [...table.values()].filter((row) => runsHermes(row.commandLine)).map((row) => row.pid).sort((a, b) => a - b);
}

/** The change an install recorded, under one marker file. */
export class PendingHermesConfig {
  constructor({ marker, io = fs, now = () => new Date().toISOString(), lockMs = APPLY_LOCK_MS, lock = {} }) {
    this.marker = marker;
    this.io = io;
    this.now = now;
    this.lock = new FileLock({ path: `${marker}.lock`, waitMs: lockMs, staleMs: lockMs, io, ...lock });
  }

  /** Record that `registry`'s servers are to be written; a later install's record replaces an earlier one. */
  record(registry) {
    const text = `${JSON.stringify({ version: 1, registry: path.resolve(registry), recordedAt: this.now() })}\n`;
    this.io.mkdirSync(path.dirname(this.marker), { recursive: true });
    const temp = `${this.marker}.${process.pid}.tmp`;
    this.io.writeFileSync(temp, text);
    this.io.renameSync(temp, this.marker);
    return text;
  }

  /** `{state: "none"}`, `{state: "pending", registry, recordedAt, text}`, or `{state: "unreadable", problem}`. */
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
    if (body?.version !== 1 || typeof body.registry !== "string" || body.registry === "" || typeof body.recordedAt !== "string") {
      return { state: "unreadable", problem: `${this.marker} is not a pending hermes config record; remove it and re-run the installer` };
    }
    return { state: "pending", registry: body.registry, recordedAt: body.recordedAt, text };
  }

  /**
   * Apply the recorded change if this host is quiet: `{outcome, detail}`, an outcome from OUTCOMES.
   *
   * @param {() => Map<number, {pid: number, commandLine: string}> | null} scan  the process table, null when unreadable
   * @param {(registry: string) => {ok: boolean, detail: string}} step  the installer's hermes step
   */
  apply({ scan, step }) {
    if (this.read().state === "none") return { outcome: "none", detail: "nothing pending" };
    try {
      return this.lock.hold((stillHeld) => this.#applyHeld({ scan, step, stillHeld }));
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) throw error;
      return { outcome: "deferred", detail: `another start still holds ${this.lock.path}; this one starts without waiting longer` };
    }
  }

  #applyHeld({ scan, step, stillHeld }) {
    const pending = this.read();
    if (pending.state === "none") return { outcome: "none", detail: "applied by another start" };
    if (pending.state === "unreadable") return { outcome: "failed", detail: pending.problem };
    const recorded = `the change an install recorded at ${pending.recordedAt}`;
    const table = scan();
    if (!table) return { outcome: "deferred", detail: `${recorded} waits: this host's processes cannot be listed, so a running hermes cannot be ruled out` };
    const running = hermesProcesses(table);
    if (running.length) {
      return { outcome: "deferred", detail: `${recorded} waits: hermes is running here (pid ${running.join(", ")}); the first hermes start that finds none applies it` };
    }
    if (!stillHeld()) return { outcome: "deferred", detail: `${recorded} waits: another start took the lock` };
    const result = step(pending.registry);
    if (!result.ok) return { outcome: "failed", detail: `${recorded} was not applied, and stays pending: ${result.detail}` };
    // Only the record that was applied: an install that recorded a newer one meanwhile leaves it for the next start.
    if (this.read().text === pending.text) this.io.rmSync(this.marker, { force: true });
    return { outcome: "applied", detail: `${recorded} is applied` };
  }
}
