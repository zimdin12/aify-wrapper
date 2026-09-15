#!/usr/bin/env node
// lib/agent-lease.mjs, lib/process-identity.mjs and bin/aify-agent-lease.mjs, with the processes faked.
//
// What is faked is ONLY the probe: which pids are alive, when each started, and what a kill does. The
// record, its lock and its file are real, in a temp directory. The same decisions against real
// processes are in an-agent-runs-once-per-host.test.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentLease, LEASE_VERSION, LeaseBusyError, REFUSED_EXIT_CODE, START_INTENTS, leaseDirectory, leaseFileName, planClaim, startIntent } from "../lib/agent-lease.mjs";
import {
  START_TIME_TOLERANCE_MS, identify, isAlive, isProtected, killTree, parseLinuxStartedAt, parseLinuxState, parsePsStartedAt,
  parseWindowsStartedAt, sleepMs, startTimes,
} from "../lib/process-identity.mjs";
import { parseLeaseArgs, runLease } from "../bin/aify-agent-lease.mjs";

const T0 = Date.parse("2026-09-15T10:00:00Z");

/** A fake host: pid -> start ms. A kill removes the pid unless it is listed as unkillable. */
function host(processes, { unkillable = [] } = {}) {
  const live = new Map(Object.entries(processes).map(([pid, at]) => [Number(pid), at]));
  const killed = [];
  return {
    killed,
    live,
    startTimes: (pids) => new Map(pids.filter((pid) => live.has(pid) && live.get(pid) !== null).map((pid) => [pid, live.get(pid)])),
    isAlive: (pid) => live.has(pid),
    killTree: (pid) => {
      killed.push(pid);
      if (!unkillable.includes(pid)) live.delete(pid);
      return true;
    },
  };
}

function lease(probe, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lease-"));
  return new AgentLease({ agentId: "agent-a", directory, probe, stopWaitMs: 50, lockWaitMs: 200, ...extra });
}

const STATES = { ours: "ours", gone: "gone", reused: "reused", unverified: "unverified" };
const stateTable = (table) => (entry) => table[entry.pid];

test("planClaim: no record claims and stops nothing", () => {
  assert.deepEqual(planClaim(null, { selfPid: 9, intent: "start", stateOf: () => "gone" }),
    { decision: "claim", live: null, stop: [], unverified: [], keepAttached: false });
});

test("planClaim: a LIVE instance refuses a start and is stopped, with its processes, by a replace", () => {
  const record = { instance: { pid: 1, attached: [{ pid: 2 }, { pid: 3 }, { pid: 4 }] } };
  const stateOf = stateTable({ 1: STATES.ours, 2: STATES.ours, 3: STATES.reused, 4: STATES.gone });
  const start = planClaim(record, { selfPid: 9, intent: "start", stateOf });
  assert.equal(start.decision, "refuse");
  assert.equal(start.live.pid, 1);
  assert.deepEqual(start.stop, [], "a refused start stops nothing");
  const replace = planClaim(record, { selfPid: 9, intent: "replace", stateOf });
  assert.equal(replace.decision, "claim");
  assert.deepEqual(replace.stop.map((e) => e.pid), [1, 2], "a reused or gone pid is never stopped");
});

test("planClaim: a DEAD instance's leftovers are stopped whatever the intent", () => {
  const record = { instance: { pid: 1, attached: [{ pid: 2 }, { pid: 3 }] } };
  for (const dead of [STATES.gone, STATES.reused]) {
    const plan = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 1: dead, 2: STATES.ours, 3: STATES.unverified }) });
    assert.equal(plan.decision, "claim");
    assert.deepEqual(plan.stop.map((e) => e.pid), [2]);
    assert.deepEqual(plan.unverified.map((e) => e.pid), [3]);
  }
});

test("planClaim: an UNVERIFIED instance neither refuses nor loses anything", () => {
  const record = { instance: { pid: 1, attached: [{ pid: 2 }] } };
  const plan = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 1: STATES.unverified, 2: STATES.ours }) });
  assert.equal(plan.decision, "claim");
  assert.deepEqual(plan.stop, [], "its attached process may belong to a live instance");
  assert.deepEqual(plan.unverified.map((e) => e.pid), [1]);
});

test("planClaim: the same launcher claiming again keeps its attachments; a recycled launcher pid does not", () => {
  const record = { instance: { pid: 9, attached: [{ pid: 2 }] } };
  const same = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 9: STATES.ours, 2: STATES.ours }) });
  assert.deepEqual([same.decision, same.keepAttached, same.stop], ["claim", true, []]);
  const recycled = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 9: STATES.reused, 2: STATES.ours }) });
  assert.deepEqual([recycled.decision, recycled.keepAttached, recycled.stop.map((e) => e.pid)], ["claim", false, [2]]);
});

test("startIntent: explicit wins; otherwise managed starts and a person replaces", () => {
  assert.deepEqual(START_INTENTS, ["start", "replace"]);
  assert.equal(startIntent({ explicit: "REPLACE", mode: "managed" }), "replace");
  assert.equal(startIntent({ explicit: "bogus", mode: "managed" }), "start");
  assert.equal(startIntent({ mode: "resident" }), "replace");
  assert.equal(startIntent({}), "replace");
});

test("leaseFileName refuses what it cannot name, rather than rewriting it into somebody else's id", () => {
  assert.equal(leaseFileName("mc-senior-dev"), "mc-senior-dev.json");
  for (const bad of ["", "a/b", "..", ".hidden", "a b"]) assert.throws(() => leaseFileName(bad));
  assert.equal(leaseDirectory({ env: { AIFY_AGENT_LEASE_DIR: "/x" } }), "/x");
  assert.equal(leaseDirectory({ env: {}, home: "/h" }), path.join("/h", ".aify", "agents"));
});

test("AgentLease: claim writes the record with the launcher's OS start time; release removes only its own", () => {
  const probe = host({ 100: T0 });
  const agent = lease(probe);
  assert.equal(agent.claim({ pid: 100, runtime: "claude", mode: "resident", intent: "replace" }).decision, "claim");
  const record = agent.read();
  assert.equal(record.version, LEASE_VERSION);
  assert.deepEqual({ ...record.instance, claimedAtMs: 0 },
    { pid: 100, startedAtMs: T0, runtime: "claude", mode: "resident", intent: "replace", claimedAtMs: 0, attached: [] });
  assert.deepEqual(agent.release({ pid: 555 }), { released: false });
  assert.ok(fs.existsSync(agent.file));
  assert.deepEqual(agent.release({ pid: 100 }), { released: true });
  assert.equal(fs.existsSync(agent.file), false);
});

test("AgentLease: a second automatic start is refused and kills nothing; an explicit one replaces", () => {
  const probe = host({ 100: T0, 101: T0 + 5, 200: T0 + 60_000 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  const refused = agent.claim({ pid: 200, intent: "start" });
  assert.deepEqual([refused.decision, refused.reason, refused.live.pid, probe.killed], ["refuse", "live", 100, []]);
  assert.equal(agent.read().instance.pid, 100, "a refusal leaves the record alone");
  const replaced = agent.claim({ pid: 200, intent: "replace" });
  assert.deepEqual([replaced.decision, probe.killed], ["claim", [100, 101]]);
  assert.equal(agent.read().instance.pid, 200);
  assert.deepEqual(agent.read().instance.attached, []);
});

test("AgentLease: a hard-killed instance's gateway is stopped by the next automatic start", () => {
  const probe = host({ 100: T0, 101: T0 + 5 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  probe.live.delete(100);
  probe.live.set(300, T0 + 90_000);
  assert.equal(agent.claim({ pid: 300, intent: "start" }).decision, "claim");
  assert.deepEqual(probe.killed, [101]);
});

test("AgentLease: a recycled pid is never killed", () => {
  const probe = host({ 100: T0, 101: T0 + 5 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  probe.live.set(100, T0 + START_TIME_TOLERANCE_MS + 1);
  probe.live.set(101, T0 + START_TIME_TOLERANCE_MS + 6);
  probe.live.set(300, T0 + 90_000);
  assert.equal(agent.claim({ pid: 300, intent: "replace" }).decision, "claim");
  assert.deepEqual(probe.killed, []);
});

test("AgentLease: a process that will not die REFUSES the start rather than make a second instance", () => {
  const probe = host({ 100: T0, 200: T0 + 60_000 }, { unkillable: [100] });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  const result = agent.claim({ pid: 200, intent: "replace" });
  assert.deepEqual([result.decision, result.reason, result.live.pid], ["refuse", "could-not-stop", 100]);
  assert.equal(agent.read().instance.pid, 100);
});

test("AgentLease: attach is ignored for an instance that no longer holds the lease", () => {
  const probe = host({ 100: T0, 101: T0 + 5 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  assert.deepEqual(agent.attach({ instance: 999, pid: 101, kind: "gateway" }), { attached: false, reason: "not-the-current-instance" });
  assert.deepEqual(agent.attach({ instance: 100, pid: 101, kind: "gateway" }), { attached: true });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  assert.deepEqual(agent.read().instance.attached, [{ pid: 101, startedAtMs: T0 + 5, kind: "gateway" }], "attached once, not twice");
});

test("AgentLease: a held lock makes a start wait, then fail; a stale one is taken over", () => {
  const probe = host({ 100: T0 });
  const agent = lease(probe);
  fs.mkdirSync(agent.directory, { recursive: true });
  fs.writeFileSync(`${agent.file}.lock`, "123");
  assert.throws(() => agent.claim({ pid: 100 }), LeaseBusyError);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(`${agent.file}.lock`, old, old);
  assert.equal(agent.claim({ pid: 100 }).decision, "claim");
  assert.equal(fs.existsSync(`${agent.file}.lock`), false, "the lock is released after the claim");
});

test("identify: ours only when alive with the recorded start, within the tolerance", () => {
  const entry = { startedAtMs: T0 };
  assert.equal(identify(entry, { alive: false, startedAt: T0 }), "gone");
  assert.equal(identify(entry, { alive: true, startedAt: null }), "unverified");
  assert.equal(identify({}, { alive: true, startedAt: T0 }), "unverified");
  assert.equal(identify(entry, { alive: true, startedAt: T0 + START_TIME_TOLERANCE_MS }), "ours");
  assert.equal(identify(entry, { alive: true, startedAt: T0 + START_TIME_TOLERANCE_MS + 1 }), "reused");
});

test("start time parsers read what each platform prints", () => {
  // Field 2 carries a space and both parentheses, which is the trap the parser exists for.
  const stat = "1234 (my (odd) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 250000 1000 50";
  assert.equal(parseLinuxStartedAt(stat, "cpu 1 2 3\nbtime 1700000000\n"), (1700000000 + 2500) * 1000);
  assert.equal(parseLinuxStartedAt("no paren", "btime 1"), null);
  assert.equal(parseLinuxStartedAt(stat, "no boot line"), null);
  const win = parseWindowsStartedAt("63780 2026-09-15T11:00:04.4084780Z\r\n102488 2026-09-15T11:00:04.4192190Z\r\ngarbage\r\n");
  assert.deepEqual([...win.keys()], [63780, 102488]);
  assert.equal(win.get(63780), Date.parse("2026-09-15T11:00:04.408Z"));
  const ps = parsePsStartedAt("  501 Tue Sep 15 10:00:00 2026\n");
  assert.equal(ps.get(501), new Date(2026, 8, 15, 10, 0, 0).getTime());
});

test("startTimes asks each platform once for every pid, and reads nothing for no pids", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args.join(" ")]); return { stdout: "7 2026-09-15T11:00:04Z\n" }; };
  assert.deepEqual(startTimes([], { platform: "win32", run }), new Map());
  assert.equal(startTimes([7, 8, 7, 0, -1], { platform: "win32", run }).get(7), Date.parse("2026-09-15T11:00:04Z"));
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /ProcessId=7 OR ProcessId=8"/);
  const files = { "/proc/stat": "btime 1700000000", "/proc/5/stat": "5 (x) S 1 5 5 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100" };
  const readFile = (file) => { if (!(file in files)) throw new Error("ENOENT"); return files[file]; };
  assert.deepEqual([...startTimes([5, 6], { platform: "linux", readFile })], [[5, 1700000001000]]);
});

test("isProtected and killTree never target nothing, init, this process or its parent", () => {
  for (const pid of [0, 1, -3, 1.5, process.pid, process.ppid]) assert.equal(isProtected(pid), true, String(pid));
  assert.equal(isProtected(4242, { self: 1, parent: 2 }), false);
  const run = () => { throw new Error("must not run"); };
  assert.equal(killTree(process.pid, { platform: "win32", run }), false);
  const seen = [];
  assert.equal(killTree(4242, { platform: "win32", run: (cmd, args) => seen.push([cmd, ...args]), protect: { self: 1, parent: 2 } }), true);
  assert.deepEqual(seen, [["taskkill", "/PID", "4242", "/T", "/F"]]);
  const signals = [];
  killTree(4242, { platform: "linux", kill: (pid, sig) => { signals.push([pid, sig]); }, protect: { self: 1, parent: 2 } });
  assert.deepEqual(signals, [[-4242, "SIGTERM"], [4242, "SIGTERM"], [-4242, "SIGKILL"], [4242, "SIGKILL"]]);
});

test("isAlive reads EPERM as alive, a Linux zombie or a missing /proc entry as gone", () => {
  assert.equal(isAlive(process.pid), true);
  const eperm = () => { const e = new Error("x"); e.code = "EPERM"; throw e; };
  assert.equal(isAlive(12, { platform: "win32", kill: eperm }), true);
  assert.equal(isAlive(12, { platform: "win32", kill: () => { const e = new Error("x"); e.code = "ESRCH"; throw e; } }), false);
  const proc = (state) => () => `12 (sleep er) ${state} 1 12 12 0 -1 0`;
  assert.equal(isAlive(12, { platform: "linux", kill: () => true, readFile: proc("S") }), true);
  assert.equal(isAlive(12, { platform: "linux", kill: () => true, readFile: proc("Z") }), false, "a zombie has exited");
  assert.equal(isAlive(12, { platform: "linux", kill: () => true, readFile: () => { throw new Error("ENOENT"); } }), false);
  assert.equal(parseLinuxState("1 (a) b) R 0"), "R");
  assert.equal(isAlive(0), false);
  const t = Date.now();
  sleepMs(20);
  assert.ok(Date.now() - t >= 15);
});

test("CLI: 75 means refused, and every failure of the helper itself exits 0 with a warning", () => {
  const probe = host({ 100: T0, 200: T0 + 60_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lease-cli-"));
  const make = (options) => new AgentLease({ ...options, directory, probe, stopWaitMs: 50 });
  const lines = [];
  const err = { write: (s) => lines.push(s) };
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "100", "--mode", "managed"], { err, lease: make }), 0);
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "200", "--mode", "managed"], { err, lease: make }), REFUSED_EXIT_CODE);
  assert.match(lines.at(-1), /agent-a is already running \(process pid 100/);
  assert.equal(runLease(["claim", "--agent=agent-a", "--pid=200", "--intent=replace"], { err, lease: make }), 0);
  assert.match(lines.at(-1), /stopped process pid 100/);
  for (const bad of [["claim", "--agent", "a/b", "--pid", "5"], ["claim", "--pid", "x"], ["nope"], ["attach", "--agent", "agent-a", "--pid", "5"]]) {
    assert.equal(runLease(bad, { err, lease: make, env: {} }), 0, bad.join(" "));
    assert.match(lines.at(-1), /WARN/);
  }
  assert.equal(runLease(["release", "--agent", "agent-a", "--pid", "200"], { err, lease: make }), 0);
  assert.equal(fs.existsSync(path.join(directory, "agent-a.json")), false);
});

test("parseLeaseArgs: instance comes from AIFY_AGENT_LEASE, intent from the mode", () => {
  const args = parseLeaseArgs(["attach", "--agent", "a", "--pid", "5", "--kind", "gateway"], { AIFY_AGENT_LEASE: "77" });
  assert.deepEqual([args.instance, args.kind, args.intent], [77, "gateway", "replace"]);
  assert.equal(parseLeaseArgs(["claim", "--agent", "a", "--pid", "5", "--mode", "managed"], {}).intent, "start");
  assert.throws(() => parseLeaseArgs(["claim", "stray"], {}));
});
