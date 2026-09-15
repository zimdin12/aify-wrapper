#!/usr/bin/env node
// The one-instance lease against REAL processes, through the real CLI, on whatever host runs the suite.
//
// agent-lease.test.js fakes the probe; this is where "stopped" means a process that was running is not,
// and "left alone" means one still is. Every process here is a node sleeper this test started, so
// nothing else on the machine can be touched: the lease directory is a temp one and each pid is our own.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "aify-agent-lease.mjs");
const started = [];

/**
 * A sleeper; with `child: true` it starts a grandchild of its own and prints that pid. On Windows the
 * grandchild breaks away from node's job too, so only a TREE kill can reach it; on POSIX it stays in its
 * parent's process group, which is where a launcher's runtime is.
 */
function sleeper({ child = false } = {}) {
  const code = child
    ? `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1e3)"],{stdio:"ignore",detached:process.platform==="win32"});console.log(c.pid);setInterval(()=>{},1e3)`
    : "setInterval(()=>{},1e3)";
  // DETACHED, as a launcher is: its own process group on POSIX (a PTY makes the launcher a session leader)
  // and outside node's kill-on-close job on Windows, where a non-detached node child dies with its parent
  // and would make the tree kill look like it worked whether or not it did.
  const proc = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"], detached: child, windowsHide: true });
  started.push(proc.pid);
  return proc;
}

async function grandchildOf(proc) {
  const pid = await new Promise((resolve) => proc.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  started.push(pid);
  return pid;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

function lease(dir, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, AIFY_AGENT_LEASE_DIR: dir }, timeout: 60_000 });
  return { status: res.status, stderr: res.stderr };
}

test.after(() => {
  for (const pid of started) {
    try { process.kill(pid); } catch {}
  }
});

test("REAL PROCESSES: an automatic start is refused by a live instance; an explicit one stops it, its tree and its gateway", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lease-real-"));
  const oldLauncher = sleeper({ child: true });
  const runtime = await grandchildOf(oldLauncher);
  const gateway = sleeper();
  const newLauncher = sleeper();

  assert.equal(lease(dir, "claim", "--agent", "real-a", "--pid", String(oldLauncher.pid), "--mode", "managed").status, 0);
  assert.equal(lease(dir, "attach", "--agent", "real-a", "--instance", String(oldLauncher.pid), "--pid", String(gateway.pid), "--kind", "gateway").status, 0);
  const record = JSON.parse(fs.readFileSync(path.join(dir, "real-a.json"), "utf8"));
  assert.ok(record.instance.startedAtMs, "control: this host read the launcher's start time, so ours is decidable");
  assert.ok(record.instance.attached[0].startedAtMs, "control: and the gateway's");

  const refused = lease(dir, "claim", "--agent", "real-a", "--pid", String(newLauncher.pid), "--mode", "managed");
  assert.equal(refused.status, 75, refused.stderr);
  assert.match(refused.stderr, new RegExp(`already running \\(process pid ${oldLauncher.pid}`));
  assert.ok([oldLauncher.pid, runtime, gateway.pid].every(alive), "a refused start stopped something");

  const replaced = lease(dir, "claim", "--agent", "real-a", "--pid", String(newLauncher.pid), "--intent", "replace");
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.ok(await until(() => ![oldLauncher.pid, runtime, gateway.pid].some(alive)),
    `still alive: ${[oldLauncher.pid, runtime, gateway.pid].filter(alive)}`);
  assert.ok(alive(newLauncher.pid), "the new launcher must survive its own claim");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "real-a.json"), "utf8")).instance.pid, newLauncher.pid);
});

test("REAL PROCESSES: a hard-killed instance's gateway is stopped by the next start, and a pid recorded with another start time is not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lease-real-"));
  const oldLauncher = sleeper();
  const gateway = sleeper();
  const stranger = sleeper();
  const next = sleeper();

  assert.equal(lease(dir, "claim", "--agent", "real-b", "--pid", String(oldLauncher.pid), "--mode", "managed").status, 0);
  lease(dir, "attach", "--agent", "real-b", "--instance", String(oldLauncher.pid), "--pid", String(gateway.pid), "--kind", "gateway");
  // THE PID-REUSE CASE, made real: a live process recorded with a start time it does not have.
  const file = path.join(dir, "real-b.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.instance.attached.push({ pid: stranger.pid, startedAtMs: record.instance.attached[0].startedAtMs - 3_600_000, kind: "gateway" });
  fs.writeFileSync(file, JSON.stringify(record));

  oldLauncher.kill("SIGKILL");
  assert.ok(await until(() => !alive(oldLauncher.pid)), "control: the instance really died");
  const claimed = lease(dir, "claim", "--agent", "real-b", "--pid", String(next.pid), "--mode", "managed");
  assert.equal(claimed.status, 0, claimed.stderr);
  assert.ok(await until(() => !alive(gateway.pid)), "the leftover gateway survived");
  assert.ok(alive(stranger.pid), "a process whose start time differs from the record was killed");
  assert.ok(alive(next.pid));
});
