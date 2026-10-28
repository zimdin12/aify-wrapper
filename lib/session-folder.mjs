// Where a launch keeps the files that can hold a key or rewrite what its session loads (its MCP config, its
// instructions): ~/.aify/sessions/<agent id>/, in a folder that is its owner's alone.
//
// WHY NOT THE SESSION'S TEMP, measured 2026-10-28. A file from `mktemp` inherits %TEMP%'s grants (on this host
// CodexSandboxUsers Modify and an unresolved SID Modify), and a launcher stopped the way aify-env stops one
// (TerminateProcess) never reaches its EXIT trap: 22 aify-comms-mcp files had piled up, 20 holding an X-API-Key.
//
// SO: ONE FILE PER AGENT, NOT PER LAUNCH. A kill leaves the agent's one file, owner-only, and its next launch replaces
// it. A launch nobody named has no agent to file under: it gets `_pid-<launcher pid>`, with the launcher's identity
// recorded, and a later start sweeps the folders of launches that have ended.
//
// THE FOLDER IS CHECKED BEFORE EVERY WRITE, never narrowed: one created here is made owner-only once, and one that grants
// anybody else refuses the write, because quietly re-narrowing would hide that something widened it.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { folderCustodyProblemFor, icaclsPath } from "./credential-custody.mjs";
import { anchorOffsetMs, identify, isAlive, startTimes } from "./process-identity.mjs";

const execFileAsync = promisify(execFile);
//: An agent id this can name a folder by: plain, so it cannot climb out of the sessions folder or name a device.
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNNAMED = /^_pid-(\d+)$/;
//: The record an unnamed launch's folder carries, read by the sweep.
const LAUNCHER_RECORD = "launcher.json";

/** The folder every launch's session files live under. */
export function sessionsRoot(home = os.homedir()) {
  return path.join(home, ".aify", "sessions");
}

/** PURE. A launch's folder name: the agent's id, or `_pid-<pid>` for a launch nobody named; null for an id it cannot be. */
export function sessionFolderName(agentId, launcherPid) {
  if (agentId === "") return Number.isInteger(launcherPid) && launcherPid > 0 ? `_pid-${launcherPid}` : null;
  return AGENT_ID.test(agentId) ? agentId : null;
}

/** Make a folder this just created its owner's alone: inheritance removed and one grant on Windows, 0700 elsewhere. */
async function restrict(dir, { platform, env, run }) {
  if (platform !== "win32") return fs.promises.chmod(dir, 0o700);
  const owner = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  if (!owner) throw new Error("no USERNAME to grant the sessions folder to");
  const icacls = icaclsPath(env);
  if (!icacls) throw new Error("no SystemRoot to find icacls by");
  await run(icacls, [dir, "/inheritance:r", "/grant:r", `${owner}:(OI)(CI)F`], { windowsHide: true, timeout: 5000 });
}

/**
 * This launch's folder, created owner-only if the sessions folder is new, and checked: `{ ok: true, dir }`, or
 * `{ ok: false, problem }` when it cannot be named, made, or trusted.
 */
export async function sessionFolder({ agentId, launcherPid, home = os.homedir(), platform = process.platform, env = process.env,
  run = execFileAsync, custody = folderCustodyProblemFor } = {}) {
  const name = sessionFolderName(agentId, launcherPid);
  if (!name) return { ok: false, problem: `no session folder can be named for agent "${agentId}"` };
  const root = sessionsRoot(home);
  const dir = path.join(root, name);
  try {
    if (!fs.existsSync(root)) {
      await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
      await restrict(root, { platform, env, run });
    }
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (failure) {
    return { ok: false, problem: `${dir} could not be made owner-only: ${failure?.message || failure}` };
  }
  const problem = await custody(dir, { platform, env });
  return problem ? { ok: false, problem: `${dir} ${problem}` } : { ok: true, dir };
}

/** Write `text` as `<dir>/<name>` whole or not at all (a temp name in the same folder, then a rename); its path. */
export async function writeSessionFile(dir, name, text) {
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
  await fs.promises.writeFile(temp, text, { mode: 0o600 });
  await fs.promises.rename(temp, file);
  return file;
}

/** Record which launcher an unnamed launch's folder belongs to, for the sweep. */
export async function recordLauncher(dir, launcherPid, now = Date.now()) {
  await writeSessionFile(dir, LAUNCHER_RECORD, `${JSON.stringify({ pid: launcherPid, seenAliveAtMs: now })}\n`);
}

/**
 * Remove the folders of unnamed launches that have ended: their launcher is gone, or its pid now names a process that
 * started later (a reused pid). A folder whose record cannot be read, or whose launcher cannot be probed, is KEPT:
 * deleting a live launch's config is the worse error, and a kept folder is owner-only. Returns the names removed.
 */
export async function sweepEndedLaunches({ home = os.homedir(), keep = "", alive = isAlive, startedAt = (pid) => startTimes([pid], { strict: true }),
  offsetMs = anchorOffsetMs } = {}) {
  const root = sessionsRoot(home);
  let names = [];
  try {
    names = fs.readdirSync(root).filter((name) => UNNAMED.test(name) && name !== keep);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(root, name, LAUNCHER_RECORD), "utf8"));
    } catch {
      continue;
    }
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid !== Number(UNNAMED.exec(name)[1])) continue;
    const living = alive(pid);
    let verdict = "gone";
    if (living) {
      const times = startedAt(pid);
      if (!times) continue;
      verdict = identify(entry, { alive: true, startedAt: times.get(pid), offsetMs: offsetMs() });
    }
    if (verdict !== "gone" && verdict !== "reused") continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
