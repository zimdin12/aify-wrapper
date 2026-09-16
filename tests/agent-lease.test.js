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

import { AgentLease, IDENTITY_FROM_FLAG, LEASE_VERSION, LeaseBusyError, REFUSED_EXIT_CODE, START_INTENTS, leaseDirectory, leaseFileName, planClaim, startIntent } from "../lib/agent-lease.mjs";
import {
  START_TIME_TOLERANCE_MS, anchorOffsetMs, ancestors, descendants, hostsOf, identify, isAlive, isProtected, killTree, linuxBootEpoch, parseLinuxStartedAt, parseLinuxState,
  orphanedChildren, parseLinuxGroup, parseProcessTable, parseStartedAtLines, processTable, sleepMs, startTimes,
} from "../lib/process-identity.mjs";
import { CLAIM_FAILED_EXIT_CODE, parseLeaseArgs, runLease, runWatch } from "../bin/aify-agent-lease.mjs";
import { startWatch, watchInstance } from "../lib/agent-lease-watch.mjs";

const T0 = Date.parse("2026-09-15T10:00:00Z");

/** A fake host: pid -> start ms, with `parents` naming each pid's parent (1 otherwise). A kill removes the pid unless it is listed as unkillable. */
function host(processes, { unkillable = [], parents = {} } = {}) {
  const live = new Map(Object.entries(processes).map(([pid, at]) => [Number(pid), at]));
  const killed = [];
  return {
    killed,
    live,
    startTimes: (pids) => new Map(pids.filter((pid) => live.has(pid) && live.get(pid) !== null).map((pid) => [pid, live.get(pid)])),
    isAlive: (pid) => live.has(pid),
    // The table every claim decides from: each live pid whose start can be read, parented to nothing.
    tableFails: false,
    processTable() {
      if (this.tableFails) return null;
      return new Map([...live].filter(([, at]) => at !== null).map(([pid, at]) => [pid, { pid, ppid: parents[pid] ?? 1, startedAtMs: at }]));
    },
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

const STATES = { ours: "ours", gone: "gone", reused: "reused", unknown: "unknown" };
const stateTable = (table) => (entry) => table[entry.pid];

test("planClaim: no record claims and stops nothing", () => {
  assert.deepEqual(planClaim(null, { selfPid: 9, intent: "start", stateOf: () => "gone" }),
    { decision: "claim", live: null, stop: [], keepAttached: false });
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
    const plan = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 1: dead, 2: STATES.ours, 3: STATES.unknown }) });
    assert.equal(plan.decision, "claim");
    assert.deepEqual(plan.stop.map((e) => e.pid), [2], "an entry of unknown identity is never stopped");
  }
});

test("planClaim: an instance of UNKNOWN identity neither refuses nor has anything of it stopped", () => {
  const record = { instance: { pid: 1, attached: [{ pid: 2 }] } };
  for (const intent of ["start", "replace"]) {
    const plan = planClaim(record, { selfPid: 9, intent, stateOf: stateTable({ 1: STATES.unknown, 2: STATES.ours }) });
    assert.deepEqual([plan.decision, plan.stop], ["claim", []], "its attached process may belong to a live instance");
  }
});

test("planClaim: the same launcher claiming again keeps its attachments; a recycled launcher pid does not", () => {
  const record = { instance: { pid: 9, attached: [{ pid: 2 }] } };
  const same = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 9: STATES.ours, 2: STATES.ours }) });
  assert.deepEqual([same.decision, same.keepAttached, same.stop], ["claim", true, []]);
  const recycled = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 9: STATES.reused, 2: STATES.ours }) });
  assert.deepEqual([recycled.decision, recycled.keepAttached, recycled.stop.map((e) => e.pid)], ["claim", false, [2]]);
});

test("startIntent: explicit wins; otherwise only a person who NAMED the agent replaces it", () => {
  assert.deepEqual(START_INTENTS, ["start", "replace"]);
  const named = IDENTITY_FROM_FLAG;
  assert.equal(startIntent({ explicit: "REPLACE", mode: "managed" }), "replace");
  assert.equal(startIntent({ explicit: "bogus", mode: "managed", identity: named }), "start");
  // An explicit word this library does not know must not end anything, whatever the mode.
  for (const mode of ["resident", "", undefined]) assert.equal(startIntent({ explicit: "restart", mode, identity: named }), "start", String(mode));
  assert.equal(startIntent({ explicit: "  ", mode: "resident", identity: named }), "replace", "control: a blank explicit value is no value");
  assert.equal(startIntent({ mode: "resident", identity: named }), "replace");
  assert.equal(startIntent({ identity: " FLAG " }), "replace");
  assert.equal(startIntent({ mode: "managed", identity: named }), "start", "a managed launch names its agent and still only starts");
  // 2026-09-15: an identity the launch took from its environment replaced a live instance of that agent.
  for (const identity of ["recovered", "", undefined, "environment"]) {
    assert.equal(startIntent({ mode: "resident", identity }), "start", `an identity from ${JSON.stringify(identity)} replaced a live instance`);
  }
  assert.equal(startIntent({}), "start", "a launch that says nothing about its identity is a guess, and a guess only starts");
});

test("startIntent: inside a running session, only an intent the COMMAND carries replaces", () => {
  const named = IDENTITY_FROM_FLAG;
  // External review, 2026-09-16: an aify-env older than the unset list hands a worker the marker AND the
  // host's own AIFY_AGENT_ID. The launcher then drops the mode, because the environment names a different
  // agent, and a named managed start read as a person and replaced the live instance it was starting.
  assert.equal(startIntent({ mode: "", identity: named, insideSession: true }), "start");
  assert.equal(startIntent({ mode: "resident", identity: named, insideSession: true }), "start");
  // The command's own word still decides: a restore says `start`, and a person can still ask for a replace.
  assert.equal(startIntent({ explicit: "replace", identity: named, insideSession: true }), "replace");
  assert.equal(startIntent({ explicit: "start", identity: named, insideSession: true }), "start");
  // CONTROL: the same launches outside a session are unchanged.
  assert.equal(startIntent({ mode: "", identity: named }), "replace");
  assert.equal(startIntent({ mode: "resident", identity: named }), "replace");
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
  assert.deepEqual({ ...record.instance, seenAliveAtMs: 0 },
    { pid: 100, startedAtMs: T0, seenAliveAtMs: 0, runtime: "claude", mode: "resident", intent: "replace", attached: [] });
  assert.deepEqual(agent.release({ pid: 555 }), { released: false, reason: "not-the-holder", stopped: [] });
  assert.ok(fs.existsSync(agent.file));
  assert.deepEqual(agent.release({ pid: 100 }), { released: true, stopped: [] });
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

test("AgentLease: a probe that fails while waiting for a stop is not a stopped process", () => {
  const probe = host({ 100: T0, 200: T0 + 60_000 }, { unkillable: [100] });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  const realStartTimes = probe.startTimes;
  probe.startTimes = (pids, options) => (options?.strict ? null : realStartTimes(pids));
  const result = agent.claim({ pid: 200, intent: "replace" });
  assert.deepEqual([result.decision, result.reason], ["refuse", "could-not-stop"]);
  assert.equal(agent.read().instance.pid, 100);
});

test("AgentLease: an older build's record whose instance is NOT running leaves leftovers that are stopped", () => {
  // No identity is needed to know a pid nobody holds is dead; what it attached is a leftover.
  const probe = host({ 101: T0 + 5, 200: T0 + 60_000 });
  const agent = lease(probe);
  fs.mkdirSync(agent.directory, { recursive: true });
  fs.writeFileSync(agent.file, JSON.stringify({ version: LEASE_VERSION, agentId: "agent-a",
    instance: { pid: 100, startedAtMs: null, attached: [{ pid: 101, startedAtMs: T0 + 5, kind: "gateway" }] } }));
  assert.equal(agent.claim({ pid: 200, intent: "start" }).decision, "claim");
  assert.deepEqual(probe.killed, [101]);
});

test("AgentLease: a replace never enters another agent's leased processes, and never ends an instance hosting one", () => {
  // Agent A's session (100 -> 150) started agent B's launcher (200). Ending A's session can end B with it -- a
  // Herdr server takes its panes, a terminal its children -- so the replace is REFUSED, and nothing is stopped.
  const probe = host({ 100: T0, 150: T0 + 1, 200: T0 + 2, 210: T0 + 3, 300: T0 + 60_000 }, { parents: { 150: 100, 200: 150, 210: 200 } });
  const trees = [];
  probe.killTree = (pid, options) => { trees.push({ pid, boundaries: [...(options?.boundaries || [])] }); probe.live.delete(pid); };
  const a = lease(probe);
  a.claim({ pid: 100, intent: "start" });
  const b = new AgentLease({ agentId: "agent-b", directory: a.directory, probe, stopWaitMs: 50, lockWaitMs: 200 });
  b.claim({ pid: 200, intent: "start" });
  b.attach({ instance: 200, pid: 210, kind: "gateway" });
  const refused = a.claim({ pid: 300, intent: "replace" });
  assert.deepEqual([refused.decision, refused.reason, refused.live?.pid], ["refuse", "hosts-another-agent", 100]);
  assert.deepEqual(trees, [], "a refused replace stopped something");
  assert.equal(a.read().instance.pid, 100, "a refused replace changed the record");

  // CONTROL: B gone, the same replace goes through, and B's leftovers are boundaries of the tree kill.
  probe.live.delete(200);
  probe.live.delete(210);
  b.attach({ instance: 200, pid: 210, kind: "gateway" });
  const unrelated = new AgentLease({ agentId: "agent-c", directory: a.directory, probe, stopWaitMs: 50, lockWaitMs: 200 });
  probe.live.set(400, T0 + 100);
  unrelated.claim({ pid: 400, intent: "start" });
  assert.equal(a.claim({ pid: 300, intent: "replace" }).decision, "claim");
  assert.deepEqual(trees.map((t) => [t.pid, t.boundaries.sort()]), [[100, [400]]], "a stale record of agent-b was still a boundary, or agent-c's was not");

  // The tree kill honours both rules on a real table shape: B's subtree stands, and so does everything above B.
  const rows = table([[100, 1, T0], [150, 100, T0 + 1], [160, 100, T0 + 1], [200, 150, T0 + 2], [210, 200, T0 + 3]]);
  const seen = [];
  assert.equal(killTree(100, { platform: "win32", run: (cmd, args) => seen.push(args), protect: { self: 999, parent: 998 }, table: rows, boundaries: [200] }), false);
  killTree(160, { platform: "win32", run: (cmd, args) => seen.push(args), protect: { self: 999, parent: 998 }, table: rows, boundaries: [200] });
  assert.deepEqual(seen, [["/F", "/PID", "160"]], "a host was ended, or a process beside it was not");
  const control = [];
  killTree(100, { platform: "win32", run: (cmd, args) => control.push(args), protect: { self: 999, parent: 998 }, table: rows });
  assert.deepEqual(control, [["/F", "/PID", "100", "/PID", "150", "/PID", "160", "/PID", "200", "/PID", "210"]], "control: with no other agent the whole tree is ended");
});

test("hostsOf names every process above another agent's, never the agent itself or a process beside it", () => {
  const rows = table([[100, 1, T0], [150, 100, T0 + 1], [160, 100, T0 + 1], [200, 150, T0 + 2], [210, 200, T0 + 3]]);
  const hosts = hostsOf([200], rows);
  assert.ok(hosts.has(150) && hosts.has(100), "a process above the boundary was not a host");
  assert.ok(!hosts.has(200) && !hosts.has(210) && !hosts.has(160), "the boundary, its child or its sibling counted as a host");
  assert.equal(hostsOf([], rows).size, 0, "with no other agent nothing hosts one");
  assert.equal(hostsOf([200], null).size, 0, "with no table nothing can be named a host");
});

test("killTree signals a POSIX group member by member, and never another agent in it (external review, 2026-09-15)", () => {
  // 10 leads group 10. 40 is 10's runtime re-parented to init; 50 is ANOTHER agent's launcher that shares the
  // group, 51 its child. The group signal reached 50 and 51 before boundaries were consulted.
  const rows = new Map([
    [10, { pid: 10, ppid: 1, pgid: 10, startedAtMs: T0 }],
    [11, { pid: 11, ppid: 10, pgid: 10, startedAtMs: T0 + 1 }],
    [40, { pid: 40, ppid: 1, pgid: 10, startedAtMs: T0 + 2 }],
    [50, { pid: 50, ppid: 1, pgid: 10, startedAtMs: T0 + 3 }],
    [51, { pid: 51, ppid: 50, pgid: 10, startedAtMs: T0 + 4 }],
  ]);
  const signals = [];
  killTree(10, { platform: "linux", kill: (pid, sig) => signals.push([pid, sig]), protect: { self: 999, parent: 998 }, table: rows, boundaries: [50] });
  assert.deepEqual(signals.filter(([, sig]) => sig === "SIGKILL").map(([pid]) => pid), [10, 11, 40]);
  assert.ok(signals.every(([pid]) => pid > 0), "a group was signalled");
});

test("AgentLease: collecting a dead instance leaves what now hosts another agent, and stops the rest", () => {
  // A (100) is gone. It left 110 (a daemon started from its session, now hosting agent B's launcher 140 via a
  // pane 130) and 115 (an ordinary leftover). The watch stops 115 and leaves 110 and its panes running.
  const probe = host({ 100: T0, 110: T0 + 1, 115: T0 + 1, 130: T0 + 2, 140: T0 + 3 }, { parents: { 110: 100, 115: 100, 130: 110, 140: 130 } });
  const a = lease(probe);
  a.claim({ pid: 100, intent: "start" });
  const b = new AgentLease({ agentId: "agent-b", directory: a.directory, probe, stopWaitMs: 50, lockWaitMs: 200 });
  b.claim({ pid: 140, intent: "start" });
  probe.live.delete(100);
  const result = a.collect({ instance: 100 });
  assert.equal(result.collected, true, JSON.stringify(result));
  assert.deepEqual(result.stopped.map((e) => e.pid), [115]);
  assert.deepEqual(probe.killed, [115], "a daemon hosting another agent was killed");
});

test("AgentLease: release STOPS what the instance attached, and keeps the record when it cannot", () => {
  // THE OPERATOR'S RULE (2026-09-15): an agent that is gone leaves nothing running. A launcher's exit only
  // signals what it started, so the detached gateway was left to run on with no agent behind it.
  const probe = host({ 100: T0, 101: T0 + 5, 102: T0 + 6 }, { unkillable: [102] });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  probe.tableFails = true;
  assert.deepEqual(agent.release({ pid: 100 }), { released: false, reason: "unreadable-processes", stopped: [] });
  assert.deepEqual([agent.read().instance.pid, probe.killed], [100, []], "a table nobody could read still let release act");
  probe.tableFails = false;
  agent.attach({ instance: 100, pid: 102, kind: "app-server" });
  const stuck = agent.release({ pid: 100 });
  assert.deepEqual([stuck.released, stuck.reason, stuck.live.pid], [false, "could-not-stop", 102]);
  assert.equal(agent.read().instance.pid, 100, "the record naming a process that would not stop was deleted");
  probe.live.delete(102);
  const released = agent.release({ pid: 100 });
  assert.deepEqual([released.released, released.stopped.map((e) => e.pid)], [true, []], "control: nothing left running, nothing to stop");
  assert.equal(fs.existsSync(agent.file), false);
  assert.ok(probe.killed.includes(101), "the attached gateway was not stopped");
  assert.deepEqual(agent.release({ pid: 555 }), { released: false, reason: "not-the-holder", stopped: [] });
});

test("AgentLease: collect stops what a GONE instance attached and left running, and nothing of anybody else's", () => {
  // 100 is the instance. 101 it attached; 110 is its runtime and 111 a server that runtime started, both
  // left running when 100 was killed; 120 took a pid 100 never had; 130 is another agent's, started beneath it.
  const probe = host({ 100: T0, 101: T0 + 5, 110: T0 + 2, 111: T0 + 3, 120: T0 - 60_000, 130: T0 + 4 },
    { parents: { 110: 100, 111: 110, 120: 100, 130: 100 } });
  const trees = [];
  probe.killTree = (pid, options) => { trees.push({ pid, boundaries: [...(options?.boundaries || [])] }); probe.live.delete(pid); if (pid === 110) probe.live.delete(111); return true; };
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  const other = new AgentLease({ agentId: "agent-b", directory: agent.directory, probe, stopWaitMs: 50, lockWaitMs: 200 });
  other.claim({ pid: 130, intent: "start" });

  assert.deepEqual(agent.collect({ instance: 100 }), { collected: false, reason: "still-running", stopped: [] });
  assert.deepEqual(trees, [], "a live instance was collected");
  assert.deepEqual(agent.collect({ instance: 555 }).reason, "not-the-holder");

  probe.live.delete(100);
  probe.tableFails = true;
  assert.equal(agent.collect({ instance: 100 }).reason, "unreadable-processes");
  assert.ok(fs.existsSync(agent.file), "a collect that could not read the table deleted the record");
  probe.tableFails = false;

  const result = agent.collect({ instance: 100 });
  assert.equal(result.collected, true);
  assert.deepEqual(trees.map((t) => t.pid).sort(), [101, 110], "the attached gateway and the orphaned runtime are what a collect stops");
  assert.ok(probe.live.has(120), "a process started before the instance was taken for its child");
  assert.ok(probe.live.has(130), "another agent's leased process was stopped");
  assert.ok(trees.every((t) => t.boundaries.includes(130)), "the tree kills were not bounded by the other agent's lease");
  assert.equal(fs.existsSync(agent.file), false);
});

test("AgentLease: a claim over a DEAD instance also stops what it left running unattached", () => {
  const probe = host({ 100: T0, 110: T0 + 2, 300: T0 + 90_000 }, { parents: { 110: 100 } });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  probe.live.delete(100);
  const claimed = agent.claim({ pid: 300, intent: "start" });
  assert.deepEqual([claimed.decision, probe.killed], ["claim", [110]]);
  // CONTROL: a LIVE instance refuses an automatic start and nothing beneath it is touched.
  const live = host({ 100: T0, 110: T0 + 2, 300: T0 + 90_000 }, { parents: { 110: 100 } });
  const again = lease(live);
  again.claim({ pid: 100, intent: "start" });
  assert.deepEqual([again.claim({ pid: 300, intent: "start" }).decision, live.killed], ["refuse", []]);
});

test("orphanedChildren: children named by a gone pid, within its life, outside the boundaries", () => {
  const rows = table([[110, 100, T0 + 2], [111, 110, T0 + 3], [120, 100, T0 - 1], [130, 100, T0 + 4], [140, 7, T0 + 5]]);
  assert.deepEqual(orphanedChildren({ pid: 100, startedAtMs: T0 }, rows).map((r) => r.pid), [110, 130], "only direct children, started after the parent");
  assert.deepEqual(orphanedChildren({ pid: 100, startedAtMs: T0 }, rows, { boundaries: new Set([130]) }).map((r) => r.pid), [110]);
  // A process that took the pid afterwards names it for ITS children: those started after it are not the gone parent's.
  const reused = table([[100, 1, T0 + 10], [110, 100, T0 + 2], [150, 100, T0 + 11]]);
  assert.deepEqual(orphanedChildren({ pid: 100, startedAtMs: T0 }, reused).map((r) => r.pid), [110]);
  assert.deepEqual(orphanedChildren({ pid: 100, seenAliveAtMs: T0 }, rows).map((r) => r.pid), [110, 130], "a moment it was seen dates it too");
  assert.deepEqual(orphanedChildren({ pid: 100 }, rows), [], "an entry with nothing to date it by has no findable children");
  // An older build wrote `startedAtMs: null`, and `row.startedAtMs >= null` is true for every row.
  assert.deepEqual(orphanedChildren({ pid: 100, startedAtMs: null, seenAliveAtMs: null }, rows), [], "a null start time matched every child of the pid");
  // LINUX re-parents a dead launcher's runtime to init; its process group still names the launcher.
  const linux = new Map([[210, { pid: 210, ppid: 1, pgid: 100, startedAtMs: T0 + 2 }], [220, { pid: 220, ppid: 1, pgid: 100, startedAtMs: T0 - 5 }], [230, { pid: 230, ppid: 1, pgid: 7, startedAtMs: T0 + 3 }]]);
  assert.deepEqual(orphanedChildren({ pid: 100, startedAtMs: T0 }, linux).map((r) => r.pid), [210], "a re-parented member of the launcher's group was not found, or one outside its life was");
  assert.deepEqual(orphanedChildren({ pid: 100, startedAtMs: T0 }, null), []);
});

test("watchInstance: collects once the instance is gone, and leaves when the lease names another", async () => {
  const calls = [];
  const fakeLease = (states, collect = { collected: true, stopped: [] }) => ({
    holderState: () => { const s = states.shift() ?? "gone"; calls.push(s); return s; },
    collect: () => { calls.push("collect"); return typeof collect === "function" ? collect() : collect; },
  });
  let alive = true;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); if (sleeps.length === 3) alive = false; };
  const collected = await watchInstance({ lease: fakeLease(["gone"]), instance: 9, isAlive: () => alive, sleep, recheckEvery: 100 });
  assert.deepEqual([collected.collected, calls], [true, ["gone", "collect"]], "the watch did not collect a dead instance");
  assert.equal(sleeps.length, 3, "control: it looked while the instance was alive, without asking the lease every time");

  calls.length = 0;
  const replaced = await watchInstance({ lease: fakeLease(["ours", "not-the-holder"]), instance: 9, isAlive: () => true, sleep: async () => {}, recheckEvery: 2 });
  assert.deepEqual([replaced.reason, calls], ["not-the-holder", ["ours", "not-the-holder"]]);

  // A pid that stays alive but belongs to another process now is an ended instance.
  calls.length = 0;
  const reused = await watchInstance({ lease: fakeLease(["reused"]), instance: 9, isAlive: () => true, sleep: async () => {}, recheckEvery: 1 });
  assert.deepEqual([reused.collected, calls], [true, ["reused", "collect"]]);

  // A collect that could not finish is retried, then left to the next claim.
  calls.length = 0;
  let tries = 0;
  const flaky = await watchInstance({ lease: fakeLease(["gone"], () => (++tries < 3 ? { collected: false, reason: "unreadable-processes", stopped: [] } : { collected: true, stopped: [] })),
    instance: 9, isAlive: () => false, sleep: async () => {}, attempts: 5 });
  assert.deepEqual([flaky.collected, tries], [true, 3]);
  tries = 0;
  const gaveUp = await watchInstance({ lease: fakeLease(["gone"], () => { tries += 1; return { collected: false, reason: "could-not-stop", stopped: [] }; }),
    instance: 9, isAlive: () => false, sleep: async () => {}, attempts: 2 });
  assert.deepEqual([gaveUp.reason, tries], ["could-not-stop", 2]);
});

test("startWatch: detached from the launcher, holding no directory, carrying no lease; none when switched off", () => {
  const spawned = [];
  const spawn = (cmd, args, options) => { spawned.push({ cmd, args, options }); return { unref() { spawned.at(-1).unref = true; } }; };
  const env = { AIFY_AGENT_LEASE: "77", AIFY_AGENT_LEASE_DIR: "/leases", PATH: "/bin" };
  startWatch({ agentId: "agent-a", instance: 100, env, script: "/w/bin/aify-agent-lease.mjs", spawn, execPath: "/node/bin/node" });
  assert.equal(spawned.length, 1);
  const [{ cmd, args, options, unref }] = spawned;
  assert.deepEqual([cmd, args], ["/node/bin/node", ["/w/bin/aify-agent-lease.mjs", "watch", "--agent", "agent-a", "--instance", "100", "--pid", "100"]]);
  assert.deepEqual([options.detached, options.stdio, options.windowsHide, options.cwd, unref], [true, "ignore", true, path.dirname("/node/bin/node"), true]);
  assert.deepEqual([options.env.AIFY_AGENT_LEASE, options.env.AIFY_AGENT_LEASE_DIR], ["", "/leases"], "the watch inherited the instance's own lease, or lost the lease directory");
  assert.equal(startWatch({ agentId: "a", instance: 1, env: { AIFY_AGENT_LEASE_WATCH: "0" }, script: "s", spawn }), null);
  assert.equal(spawned.length, 1, "a switched-off watch was started anyway");
});

test("runWatch: a watch that cannot work never throws", async () => {
  assert.equal(await runWatch(["watch", "--agent", "a/b", "--pid", "5", "--instance", "5"], { env: {} }), 0);
  assert.equal(await runWatch(["watch", "--agent", "a", "--pid", "5"], { env: {}, lease: () => { throw new Error("no"); } }), 0);
  let asked = 0;
  const fake = () => ({ holderState: () => { asked += 1; return "not-the-holder"; }, collect: () => ({}) });
  assert.equal(await runWatch(["watch", "--agent", "a", "--pid", "5", "--instance", "5"], { env: {}, lease: fake, alive: () => false, sleep: async () => {} }), 0);
  assert.equal(asked, 1, "control: a well-formed watch asked the lease");
});

test("AgentLease: seenAliveAtMs is stamped BEFORE the claim observes anything", () => {
  const probe = host({ 100: T0 });
  let clock = 5_000;
  const agent = lease(probe, { now: () => clock });
  const realTable = probe.processTable.bind(probe);
  probe.processTable = () => { clock += 10_000; return realTable(); };
  fs.mkdirSync(agent.directory, { recursive: true });
  fs.writeFileSync(agent.file, JSON.stringify({ version: LEASE_VERSION, agentId: "agent-a", instance: { pid: 999, startedAtMs: T0 } }));
  agent.claim({ pid: 100, intent: "start" });
  assert.equal(agent.read().instance.seenAliveAtMs, 5_000, "stamped after the table read, which widens the reused-pid window");
});

test("AgentLease: attach is ignored for an instance that no longer holds the lease", () => {
  const probe = host({ 100: T0, 101: T0 + 5 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  assert.deepEqual(agent.attach({ instance: 999, pid: 101, kind: "gateway" }), { attached: false, reason: "not-the-current-instance" });
  assert.deepEqual(agent.attach({ instance: 100, pid: 101, kind: "gateway" }), { attached: true });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  assert.deepEqual(agent.read().instance.attached.map(({ seenAliveAtMs, ...rest }) => rest), [{ pid: 101, startedAtMs: T0 + 5, kind: "gateway" }], "attached once, not twice");
  assert.deepEqual(agent.attach({ instance: 100, pid: 555, kind: "gateway" }), { attached: false, reason: "not-running" });
});

test("AgentLease: a held lock makes a start wait, then fail; an old or empty lock is taken over", () => {
  // 123 is alive and started before it took the lock: a live holder.
  const probe = host({ 100: T0, 123: T0 - 1_000 });
  const agent = lease(probe);
  fs.mkdirSync(agent.directory, { recursive: true });
  const lock = `${agent.file}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: 123, atMs: Date.now() }));
  assert.throws(() => agent.claim({ pid: 100 }), LeaseBusyError);
  const old = new Date(Date.now() - 121_000);
  fs.utimesSync(lock, old, old);
  assert.equal(agent.claim({ pid: 100 }).decision, "claim");
  assert.equal(fs.existsSync(lock), false, "the lock is released after the claim");
  // A lock naming nobody (a crash between create and write) waits briefly, then goes.
  fs.writeFileSync(lock, "");
  assert.throws(() => agent.claim({ pid: 100 }), LeaseBusyError);
  const elevenSecondsAgo = new Date(Date.now() - 11_000);
  fs.utimesSync(lock, elevenSecondsAgo, elevenSecondsAgo);
  assert.equal(agent.claim({ pid: 100 }).decision, "claim");
});

test("AgentLease: a live lock holder is not taken over because the boot anchor and the wall clock disagree", () => {
  // EXTERNAL REVIEW, 2026-09-16. Start times come from the boot anchor so they stop moving; the lock
  // records the wall-clock moment it was taken. The two clocks drift apart -- measured on this machine's
  // WSL, the anchor was 121 s behind live btime -- so an anchored start time compared with a wall-clock
  // moment is wrong by that offset. Ahead, and a holder that has just taken the lock reads as a pid
  // recycled after it: the next start takes over a LIVE holder's lock, which is the two-starts-at-once
  // case the lock exists to prevent.
  const offsetMs = 18_000;
  const probe = host({ 100: T0, 123: Date.now() + offsetMs });
  probe.anchorOffsetMs = () => offsetMs;
  const agent = lease(probe);
  fs.mkdirSync(agent.directory, { recursive: true });
  const lock = `${agent.file}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: 123, atMs: Date.now() }));
  assert.throws(() => agent.claim({ pid: 100 }), LeaseBusyError, "a live holder's lock was taken over");
  // CONTROL: a pid that really did start after the lock was taken -- beyond the offset -- is still reused.
  probe.live.set(123, Date.now() + offsetMs + 60_000);
  assert.equal(agent.claim({ pid: 100 }).decision, "claim", "a recycled pid still holds the lock");
});

test("AgentLease: a holder that dies WHILE a start waits is noticed, not cached as alive", () => {
  const probe = host({ 100: T0, 4000: T0 - 1_000 });
  const agent = lease(probe, { lockWaitMs: 8_000 });
  fs.mkdirSync(agent.directory, { recursive: true });
  fs.writeFileSync(`${agent.file}.lock`, JSON.stringify({ pid: 4000, atMs: Date.now() }));
  let asked = 0;
  const realIsAlive = probe.isAlive;
  probe.isAlive = (pid) => (pid === 4000 ? ++asked < 2 : realIsAlive(pid));
  const started = Date.now();
  assert.equal(agent.claim({ pid: 100 }).decision, "claim");
  assert.ok(asked >= 2, "the holder was asked about only once");
  assert.ok(Date.now() - started < 6_000, "the start waited out its whole budget behind a dead holder");
});

test("AgentLease: a start that loses the lock mid-claim writes no record and removes nobody's lock", () => {
  const probe = host({ 100: T0 });
  const agent = lease(probe);
  const theirs = JSON.stringify({ pid: 999999, atMs: Date.now(), nonce: "theirs" });
  const racing = new AgentLease({ agentId: "agent-a", directory: agent.directory, probe, stopWaitMs: 50, lockWaitMs: 200, io: {
    ...fs,
    // Another start takes the path the moment this one has taken it.
    writeFileSync: (file, data, options) => {
      fs.writeFileSync(file, data, options);
      if (String(file).endsWith(".lock") && options?.flag === "wx") fs.writeFileSync(file, theirs);
    },
  } });
  assert.throws(() => racing.claim({ pid: 100 }), LeaseBusyError);
  assert.equal(fs.readFileSync(`${agent.file}.lock`, "utf8"), theirs, "the other start's lock was removed");
  assert.equal(agent.read(), null, "a start that lost the lock wrote the record");
});

test("planClaim: a start INSIDE the live instance is refused as nested, even a replace, and stops no ancestor", () => {
  const record = { instance: { pid: 1, attached: [{ pid: 2 }] } };
  const stateOf = stateTable({ 1: STATES.ours, 2: STATES.ours });
  for (const intent of ["start", "replace"]) {
    const byLease = planClaim(record, { selfPid: 9, intent, stateOf, inherited: 1 });
    assert.deepEqual([byLease.decision, byLease.live.pid, byLease.stop], ["nested", 1, []], intent);
    const byTree = planClaim(record, { selfPid: 9, intent, stateOf, ancestry: new Set([9, 5, 1]) });
    assert.deepEqual([byTree.decision, byTree.stop], ["nested", []], intent);
  }
  // CONTROL: an inherited lease naming some OTHER instance is not this one, so a replace still replaces.
  assert.deepEqual(planClaim(record, { selfPid: 9, intent: "replace", stateOf, inherited: 77 }).stop.map((e) => e.pid), [1, 2]);
  // A dead instance's attached process that is this launcher's ancestor is left alone.
  const dead = planClaim(record, { selfPid: 9, intent: "start", stateOf: stateTable({ 1: STATES.gone, 2: STATES.ours }), ancestry: new Set([9, 2]) });
  assert.deepEqual(dead.stop, []);
});

test("identify: an entry recorded with no start time is still decided by when it was seen alive", () => {
  assert.equal(identify({ seenAliveAtMs: T0 }, { alive: true, startedAt: T0 - 60_000 }), "ours");
  assert.equal(identify({ seenAliveAtMs: T0 }, { alive: true, startedAt: T0 }), "ours");
  assert.equal(identify({ seenAliveAtMs: T0 }, { alive: true, startedAt: T0 + 1 }), "reused", "started after it was seen: another process");
  assert.equal(identify({ seenAliveAtMs: T0 }, { alive: true, startedAt: null }), "unknown");
  assert.equal(identify({ startedAtMs: T0, seenAliveAtMs: T0 + 90_000 }, { alive: true, startedAt: T0 + 60_000 }), "reused", "a recorded start time wins");
  assert.equal(START_TIME_TOLERANCE_MS, 2_000);
});

test("AgentLease: an unreadable process table with a recorded process still running REFUSES, whatever the intent", () => {
  // THE HOLE THIS CLOSES: a claim that let the start through without recording it (a probe hiccup) left a
  // live launcher off the record, so the next automatic start was not refused. Nothing starts blind now.
  const probe = host({ 100: T0, 101: T0 + 5, 200: T0 + 60_000 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  agent.attach({ instance: 100, pid: 101, kind: "gateway" });
  probe.tableFails = true;
  for (const intent of ["start", "replace"]) {
    const result = agent.claim({ pid: 200, intent });
    assert.deepEqual([result.decision, result.reason, probe.killed], ["refuse", "unreadable-processes", []], intent);
  }
  // Only the gateway still runs: still refused, since it may belong to a live instance.
  probe.live.delete(100);
  assert.equal(agent.claim({ pid: 200, intent: "start" }).reason, "unreadable-processes");
  // CONTROL: nothing recorded is running, so the table is not needed and the start claims.
  probe.live.delete(101);
  assert.equal(agent.claim({ pid: 200, intent: "start" }).decision, "claim");
  assert.equal(agent.read().instance.pid, 200);
});

test("AgentLease: a launcher whose start time could not be read is still refused against, and still stopped by a replace", () => {
  const probe = host({ 100: null, 200: T0 + 60_000 });
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "start" });
  assert.equal(agent.read().instance.startedAtMs, null);
  probe.live.set(100, T0);
  const refused = agent.claim({ pid: 200, intent: "start" });
  assert.deepEqual([refused.decision, refused.live.pid], ["refuse", 100], "the probe works again and the instance is identified");
  assert.equal(agent.claim({ pid: 200, intent: "replace" }).decision, "claim");
  assert.deepEqual(probe.killed, [100]);
});

test("AgentLease: a record with no identity (an older build's) never blocks, and nothing of it is stopped; a probe failure is retried", () => {
  const probe = host({ 100: T0, 101: T0 + 5, 200: T0 + 60_000 });
  const agent = lease(probe);
  fs.mkdirSync(agent.directory, { recursive: true });
  fs.writeFileSync(agent.file, JSON.stringify({ version: LEASE_VERSION, agentId: "agent-a",
    instance: { pid: 100, startedAtMs: null, attached: [{ pid: 101, startedAtMs: T0 + 5, kind: "gateway" }] } }));
  assert.equal(agent.claim({ pid: 200, intent: "start" }).decision, "claim");
  assert.deepEqual(probe.killed, [], "a gateway of an instance nobody can identify was stopped");
  assert.equal(agent.read().instance.pid, 200);

  const flaky = host({ 300: T0 });
  const realStartTimes = flaky.startTimes;
  let calls = 0;
  flaky.startTimes = (pids) => (++calls === 1 ? new Map() : realStartTimes(pids));
  const retried = lease(flaky);
  retried.claim({ pid: 300, intent: "start" });
  assert.equal(retried.read().instance.startedAtMs, T0);
});

test("AgentLease: a launcher started inside the live instance is refused and ends nothing, by its ancestry alone", () => {
  const probe = host({ 100: T0, 300: T0 + 60_000 });
  let tableReads = 0;
  probe.processTable = () => { tableReads += 1; return table([[100, 1, T0], [250, 100, T0 + 10], [300, 250, T0 + 60_000]]); };
  const agent = lease(probe);
  agent.claim({ pid: 100, intent: "replace" });
  assert.equal(tableReads, 0, "an uncontended claim does not pay for the table");
  const nested = agent.claim({ pid: 300, intent: "replace" });
  assert.deepEqual([nested.decision, nested.live.pid, probe.killed, agent.read().instance.pid], ["nested", 100, [], 100]);
  assert.equal(tableReads, 1);
  // CONTROL: the same start from outside the instance replaces it.
  probe.processTable = () => table([[100, 1, T0], [300, 1, T0 + 60_000]]);
  assert.equal(agent.claim({ pid: 300, intent: "replace" }).decision, "claim");
  assert.deepEqual(probe.killed, [100]);
});

test("AgentLease: a lock whose holder is gone is taken over at once; a live holder's is waited on", () => {
  const probe = host({ 100: T0, 4000: T0 - 1_000 });
  const agent = lease(probe, { lockWaitMs: 60_000 });
  fs.mkdirSync(agent.directory, { recursive: true });
  const lock = `${agent.file}.lock`;
  fs.writeFileSync(lock, JSON.stringify({ pid: 3999, atMs: Date.now() }));
  const started = Date.now();
  assert.equal(agent.claim({ pid: 100 }).decision, "claim");
  assert.ok(Date.now() - started < 5_000, "a dead holder was waited on");
  fs.writeFileSync(lock, JSON.stringify({ pid: 4000, atMs: Date.now() }));
  assert.throws(() => lease(probe, { lockWaitMs: 300, directory: agent.directory }).claim({ pid: 100 }), LeaseBusyError);
  // A holder whose pid now belongs to a process started after it took the lock is gone too.
  probe.live.set(4000, Date.now() + 5_000);
  assert.equal(lease(probe, { lockWaitMs: 300, directory: agent.directory }).claim({ pid: 100 }).decision, "claim");
});

test("CLI: a start that finds another start of the agent still holding the lock is REFUSED, not let through", () => {
  const probe = host({ 100: T0, 4000: T0 - 1_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lease-busy-"));
  fs.writeFileSync(path.join(directory, "agent-a.json.lock"), JSON.stringify({ pid: 4000, atMs: Date.now() }));
  const lines = [];
  const make = (options) => new AgentLease({ ...options, directory, probe, lockWaitMs: 200, stopWaitMs: 50 });
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "100"], { err: { write: (l) => lines.push(l) }, lease: make, env: {} }), REFUSED_EXIT_CODE);
  assert.match(lines.at(-1), /another start of this agent is still in progress/);
  // A nested start is refused too, and says why.
  fs.rmSync(path.join(directory, "agent-a.json.lock"));
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "100", "--intent", "replace"], { err: { write: (l) => lines.push(l) }, lease: make, env: {} }), 0);
  probe.live.set(200, T0 + 1);
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "200", "--intent", "replace"], { err: { write: (l) => lines.push(l) }, lease: make, env: { AIFY_AGENT_LEASE: "100" } }), REFUSED_EXIT_CODE);
  assert.match(lines.at(-1), /runs inside agent-a's own live instance/);
  assert.deepEqual(probe.killed, []);
});

test("identify: ours only when alive with the recorded start, within the tolerance", () => {
  const entry = { startedAtMs: T0 };
  assert.equal(identify(entry, { alive: false, startedAt: T0 }), "gone");
  assert.equal(identify(entry, { alive: true, startedAt: null }), "unknown");
  assert.equal(identify({}, { alive: true, startedAt: T0 }), "unknown");
  assert.equal(identify(entry, { alive: true, startedAt: T0 + START_TIME_TOLERANCE_MS }), "ours");
  assert.equal(identify(entry, { alive: true, startedAt: T0 + START_TIME_TOLERANCE_MS + 1 }), "reused");
});

test("start time parsers read what each platform prints", () => {
  // Field 2 carries a space and both parentheses, which is the trap the parser exists for.
  const stat = "1234 (my (odd) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 250000 1000 50";
  assert.equal(parseLinuxStartedAt(stat, "cpu 1 2 3\nbtime 1700000000\n"), (1700000000 + 2500) * 1000);
  assert.equal(parseLinuxStartedAt("no paren", "btime 1"), null);
  assert.equal(parseLinuxStartedAt(stat, "no boot line"), null);
  const win = parseStartedAtLines("63780 2026-09-15T11:00:04.4084780Z\r\n102488 2026-09-15T11:00:04.4192190Z\r\ngarbage\r\n");
  assert.deepEqual([...win.keys()], [63780, 102488]);
  assert.equal(win.get(63780), Date.parse("2026-09-15T11:00:04.408Z"));
  const ps = parseStartedAtLines("  501 Tue Sep 15 10:00:00 2026\n");
  assert.equal(ps.get(501), new Date(2026, 8, 15, 10, 0, 0).getTime());
});

test("startTimes asks each platform once for every pid, and reads nothing for no pids", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args.join(" ")]); return { stdout: "7 2026-09-15T11:00:04Z\n", status: 0 }; };
  assert.deepEqual(startTimes([], { platform: "win32", run }), new Map());
  assert.equal(startTimes([7, 8, 7, 0, -1], { platform: "win32", run }).get(7), Date.parse("2026-09-15T11:00:04Z"));
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /ProcessId=7 OR ProcessId=8"/);
  const files = { "/proc/stat": "btime 1700000000", "/proc/5/stat": "5 (x) S 1 5 5 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100" };
  const readFile = (file) => { if (!(file in files)) throw new Error("ENOENT"); return files[file]; };
  assert.deepEqual([...startTimes([5, 6], { platform: "linux", readFile })], [[5, 1700000001000]]);
  // A probe that FAILED is not an answer that the processes are gone: strict says so, lenient stays a Map.
  const timedOut = () => ({ stdout: "7 2026-09-15T11:00:04Z\n", status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) });
  assert.equal(startTimes([7], { platform: "win32", run: timedOut, strict: true }), null);
  assert.equal(startTimes([7], { platform: "win32", run: () => ({ stdout: "", status: 1 }), strict: true }), null, "a non-zero exit with no error");
  assert.deepEqual(startTimes([7], { platform: "win32", run: timedOut }), new Map());
  assert.deepEqual(startTimes([7], { platform: "darwin", run: () => ({ stdout: "", status: 1 }), strict: true }), new Map(), "ps exits 1 when no pid exists: an answer");
  assert.equal(startTimes([7], { platform: "linux", readFile: () => { throw new Error("EACCES"); }, strict: true }), null);
});

test("isProtected and killTree never target nothing, init, this process or its parent", () => {
  for (const pid of [0, 1, -3, 1.5, process.pid, process.ppid]) assert.equal(isProtected(pid), true, String(pid));
  assert.equal(isProtected(4242, { self: 1, parent: 2 }), false);
  const run = () => { throw new Error("must not run"); };
  assert.equal(killTree(process.pid, { platform: "win32", run }), false);
  const seen = [];
  assert.equal(killTree(4242, { platform: "win32", run: (cmd, args) => seen.push([cmd, ...args]), protect: { self: 1, parent: 2 }, table: null }), true);
  assert.deepEqual(seen, [["taskkill", "/F", "/PID", "4242"]], "an unreadable table ends the pid alone, never a /T walk");
  const signals = [];
  killTree(4242, { platform: "linux", kill: (pid, sig) => { signals.push([pid, sig]); }, protect: { self: 1, parent: 2 }, table: null });
  assert.deepEqual(signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]], "an unreadable table signals the pid alone, never its group");
});

/** A process table: [pid, ppid, start]. */
const table = (rows) => new Map(rows.map(([pid, ppid, startedAtMs]) => [pid, { pid, ppid, startedAtMs }]));

test("ancestors stop at a parent that started after its child: that pid was reused, it is not an ancestor", () => {
  // 50 names parent 40, but 40 started later: 40 now belongs to some other process. 60 is unlisted.
  const rows = table([[50, 40, T0], [40, 1, T0 + 5_000], [70, 60, T0]]);
  assert.deepEqual([...ancestors(50, rows)], [50]);
  assert.deepEqual([...ancestors(70, rows)], [70, 60], "an unlisted parent is still named, and the walk ends there");
  // A parent and child can start in the same millisecond (Linux reads 10 ms ticks): that is still parentage.
  assert.deepEqual([...ancestors(81, table([[80, 1, T0], [81, 80, T0]]))], [81, 80, 1]);
});

test("descendants follow real children only: a child older than its parent names a pid that was reused", () => {
  const rows = table([[10, 1, T0], [11, 10, T0 + 1], [12, 11, T0 + 2], [13, 10, T0 - 5_000], [14, 13, T0 - 4_000], [20, 1, T0]]);
  assert.deepEqual(descendants(10, rows), [11, 12], "13 started before 10 existed, so 10 is not its parent");
  assert.deepEqual(descendants(10, null), []);
  assert.deepEqual([...ancestors(12, rows)], [12, 11, 10, 1]);
  assert.deepEqual([...ancestors(12, null)], [12]);
});

test("killTree ends the verified tree on both platforms and never the caller's own ancestry", () => {
  const rows = table([[10, 1, T0], [11, 10, T0 + 1], [13, 10, T0 - 5_000], [30, 11, T0 + 3]]);
  const seen = [];
  killTree(10, { platform: "win32", run: (cmd, args) => seen.push([cmd, ...args]), protect: { self: 999, parent: 998 }, table: rows });
  assert.deepEqual(seen, [["taskkill", "/F", "/PID", "10", "/PID", "11", "/PID", "30"]]);
  const signals = [];
  killTree(10, { platform: "linux", kill: (pid, sig) => signals.push([pid, sig]), protect: { self: 999, parent: 998 }, table: rows });
  assert.deepEqual(signals.filter(([, sig]) => sig === "SIGKILL").map(([pid]) => pid), [10, 11, 30], "every process is signalled by pid");
  // The caller (30) sits under 10: nothing above it is ended, and a named spare is left out of the tree.
  const guarded = [];
  assert.equal(killTree(10, { platform: "win32", run: (cmd, args) => guarded.push(args), protect: { self: 30, parent: 998 }, table: rows }), false);
  killTree(10, { platform: "win32", run: (cmd, args) => guarded.push(args), protect: { self: 999, parent: 998 }, table: rows, spare: [11] });
  assert.deepEqual(guarded, [["/F", "/PID", "10", "/PID", "30"]]);
});

test("processTable on THIS host lists this process with its parent and the start time startTimes reports", () => {
  const rows = processTable();
  assert.ok(rows && rows.size > 5, "the host table could not be read");
  const self = rows.get(process.pid);
  assert.ok(self, "this process is missing from the table");
  assert.ok(Math.abs(self.startedAtMs - startTimes([process.pid]).get(process.pid)) <= START_TIME_TOLERANCE_MS);
  assert.ok(ancestors(process.pid, rows).size >= 2, "no parent was followed");
  assert.equal(processTable({ platform: "win32", run: () => ({ stdout: "", status: 0 }) }), null, "an empty listing is no table, not an empty one");
  const partial = "4 0 2026-09-15T10:00:00Z\n8 4 2026-09-15T10:00:01Z\n";
  assert.equal(processTable({ platform: "win32", run: () => ({ stdout: partial, status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }) }), null,
    "a query that timed out printed part of the table, and part of a table was trusted");
  assert.equal(processTable({ platform: "win32", run: () => ({ stdout: partial, status: 0 }) }).size, 2, "control: the same rows from a clean exit are read");
  assert.equal(processTable({ platform: "win32", run: () => ({ stdout: partial, status: 1 }) }), null, "a non-zero exit with no error is a failed query too");
  assert.equal(processTable({ platform: "win32", run: () => ({ stdout: partial, status: 0, error: Object.assign(new Error("b"), { code: "ENOBUFS" }) }) }), null, "an error with a zero status is a failed query too");
  const procs = { "/proc/stat": "btime 1700000000", "/proc/5/stat": "5 (a) S 1 5 5 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100", "/proc/6/stat": "6 (b) Z 1 6 6 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100" };
  const linux = processTable({ platform: "linux", readDir: () => ["5", "6", "self"], readFile: (f) => { if (!(f in procs)) throw new Error("ENOENT"); return procs[f]; } });
  assert.deepEqual([...linux.keys()], [5], "a zombie is not a running process");
  const grouped = { "/proc/stat": "btime 1700000000", "/proc/7/stat": "7 (a (b)) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100" };
  const row = processTable({ platform: "linux", readDir: () => ["7"], readFile: (f) => grouped[f] }).get(7);
  assert.deepEqual([row.ppid, row.pgid], [1, 42], "the group is read after the last parenthesis, like every other field");
  assert.equal(parseLinuxGroup("garbage"), null);
});

test("a Linux boot's start is kept for the boot, so a clock step does not move a process's start (external review, 2026-09-15)", () => {
  const BOOT_ID = "0f3c8d2e-1b4a-4c5d-9e6f-7a8b9c0d1e2f";
  const files = new Map([["/proc/sys/kernel/random/boot_id", `${BOOT_ID}\n`]]);
  const owners = new Map();
  const fsFake = {
    readFile: (f) => { if (!files.has(f)) throw new Error("ENOENT"); return files.get(f); },
    writeFile: (f, v, { flag }) => { if (flag === "wx" && files.has(f)) throw new Error("EEXIST"); files.set(f, v); owners.set(f, 1000); },
    ownerOf: (f) => { if (!owners.has(f)) throw new Error("ENOENT"); return owners.get(f); },
    uid: 1000,
  };
  const stat = "5 (a) S 1 5 5 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100";
  const before = linuxBootEpoch({ procStat: "btime 1700000000", ...fsFake });
  assert.equal(before, 1700000000, "the first reader keeps the live btime");
  // The clock steps forward 90 s: /proc/stat now says the boot was 90 s later.
  const after = linuxBootEpoch({ procStat: "btime 1700000090", ...fsFake });
  assert.equal(after, 1700000000, "a clock step moved the boot a later reader computes from");
  assert.equal(parseLinuxStartedAt(stat, "btime 1700000090", after), parseLinuxStartedAt(stat, "btime 1700000000", before));
  assert.notEqual(parseLinuxStartedAt(stat, "btime 1700000090"), parseLinuxStartedAt(stat, "btime 1700000000"), "control: the live btime does move");

  // Not believed: a file another user owns. Not available: no boot id, no uid.
  owners.set(`/dev/shm/aify-boot-1000-${BOOT_ID}`, 0);
  assert.equal(linuxBootEpoch({ procStat: "btime 1700000090", ...fsFake }), 1700000090, "a file this user does not own was believed");
  assert.equal(linuxBootEpoch({ procStat: "btime 1700000090", ...fsFake, readFile: () => { throw new Error("ENOENT"); } }), 1700000090);
  assert.equal(linuxBootEpoch({ procStat: "btime 1700000090", ...fsFake, uid: undefined }), 1700000090);
  assert.equal(linuxBootEpoch({ procStat: "no btime", ...fsFake, readFile: () => { throw new Error("ENOENT"); } }), null);
});

test("anchorOffsetMs says how far anchored start times sit from the wall clock (external review, 2026-09-16)", () => {
  // The anchor keeps the boot the host first reported; `btime` then drifts. That difference is what a
  // wall-clock comparison has to subtract, and getting its SIGN wrong is the bug it exists to stop.
  const stepped = (live, anchored) => anchorOffsetMs({ platform: "linux", readFile: () => `btime ${live}\n`, bootEpoch: () => anchored });
  assert.equal(stepped(1700000000, 1700000018), 18_000, "an anchor AHEAD of btime makes a start time read later than it was");
  assert.equal(stepped(1700000124, 1700000003), -121_000, "measured shape: this machine's WSL, anchor 121 s behind");
  assert.equal(stepped(1700000000, 1700000000), 0, "control: no drift, no offset");
  // Nothing to answer with is 0, never a guess: a wrong offset is worse than none.
  assert.equal(anchorOffsetMs({ platform: "win32", readFile: () => { throw new Error("no /proc here"); } }), 0);
  assert.equal(anchorOffsetMs({ platform: "linux", readFile: () => "no btime", bootEpoch: () => null }), 0);
  assert.equal(anchorOffsetMs({ platform: "linux", readFile: () => { throw new Error("ENOENT"); } }), 0);
});

test("identify puts an anchored start time on the entry's own clock before judging it", () => {
  const offsetMs = 18_000;
  const started = 1_700_000_000_000;
  // A record written by another program, in wall-clock terms: the same process, read through the anchor.
  assert.equal(identify({ startedAtMs: started }, { alive: true, startedAt: started + offsetMs, offsetMs }), "ours");
  assert.equal(identify({ startedAtMs: started }, { alive: true, startedAt: started + offsetMs }), "reused", "control: without the offset the same process is a stranger");
  // The seen-alive branch, which is what the lock uses.
  assert.equal(identify({ seenAliveAtMs: started }, { alive: true, startedAt: started + offsetMs - 1, offsetMs }), "ours");
  assert.equal(identify({ seenAliveAtMs: started }, { alive: true, startedAt: started + offsetMs + 1, offsetMs }), "reused", "control: a pid that really started later is still reused");
});

test("AgentLease: a record is written on ONE clock, so a start time it could not read is still judged right", () => {
  // The claim could not read pid 100's start time, so the record keeps only the moment it was seen alive.
  // That moment must sit on the same clock as the start times it is compared against.
  const offsetMs = 18_000;
  const probe = host({ 100: null });
  probe.anchorOffsetMs = () => offsetMs;
  const agent = lease(probe);
  const before = Date.now();
  agent.claim({ pid: 100 });
  const seen = agent.read().instance.seenAliveAtMs;
  assert.ok(seen >= before + offsetMs, `the seen moment was left on the wall clock (${seen - before} ms past it, expected at least ${offsetMs})`);
  // And it judges the live process as ours: its anchored start is before the anchored moment it was seen.
  probe.live.set(100, before + offsetMs - 1_000);
  assert.equal(agent.holderState(100), "ours", "a live instance read as something else");
});

test("on THIS Linux host a stepped /proc/stat leaves every start time where it was", { skip: process.platform !== "linux" && "reads the real /proc and /dev/shm" }, () => {
  const real = (f, enc) => fs.readFileSync(f, enc);
  const stepped = (f, enc) => (f === "/proc/stat" ? String(real(f, enc)).replace(/^btime\s+(\d+)/m, (_, s) => `btime ${Number(s) + 90}`) : real(f, enc));
  const plain = startTimes([process.pid], { readFile: real }).get(process.pid);
  assert.ok(plain > 0, "control: this process's start was read");
  assert.equal(startTimes([process.pid], { readFile: stepped }).get(process.pid), plain);
  assert.equal(processTable({ readFile: stepped }).get(process.pid).startedAtMs, plain);
});

test("parseProcessTable reads CIM and ps rows", () => {
  const rows = parseProcessTable("4 0 2026-09-15T10:00:00.0000000Z\r\n  501   1 Tue Sep 15 10:00:00 2026\njunk\n");
  assert.deepEqual(rows.get(4), { pid: 4, ppid: 0, startedAtMs: Date.parse("2026-09-15T10:00:00Z") });
  assert.equal(rows.get(501).ppid, 1);
  assert.equal(rows.size, 2);
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
  const watched = [];
  const watch = (options) => watched.push(options);
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "100", "--mode", "managed"], { err, lease: make, watch }), 0);
  assert.deepEqual(watched.map((w) => [w.agentId, w.instance, path.basename(w.script)]), [["agent-a", 100, "aify-agent-lease.mjs"]], "a claim did not start its watch");
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "200", "--mode", "managed", "--identity", "flag"], { err, lease: make, watch }), REFUSED_EXIT_CODE);
  assert.equal(watched.length, 1, "a refused start started a watch");
  assert.match(lines.at(-1), /agent-a is already running \(process pid 100.*An automatic start does not replace it/);
  // A resident start that did not name the agent is refused too, and told how to name it.
  assert.equal(runLease(["claim", "--agent", "agent-a", "--pid", "200", "--mode", "resident"], { err, lease: make, watch }), REFUSED_EXIT_CODE);
  assert.match(lines.at(-1), /agent-a is already running \(process pid 100.*did not name the agent.*start it with --aify-agent agent-a\./);
  assert.equal(runLease(["claim", "--agent=agent-a", "--pid=200", "--intent=replace"], { err, lease: make, watch }), 0);
  assert.match(lines.at(-1), /stopped process pid 100/);
  assert.equal(runLease(["claim", "--agent=agent-a", "--pid=200"], { err, lease: make, watch: () => { throw new Error("spawn EAGAIN"); } }), 0, "a watch that failed to start failed the start");
  assert.match(lines.at(-1), /could not start the watch/);
  // A failed CLAIM exits neither 0 (which the launcher reads as holding the lease) nor 75 (refused); any other
  // failed command exits 0.
  for (const bad of [["claim", "--agent", "a/b", "--pid", "5"], ["claim", "--pid", "x"], ["claim", "--agnet", "agent-a", "--pid", "5"]]) {
    assert.equal(runLease(bad, { err, lease: make, env: {} }), CLAIM_FAILED_EXIT_CODE, bad.join(" "));
    assert.match(lines.at(-1), /WARN/);
  }
  assert.notEqual(CLAIM_FAILED_EXIT_CODE, 0);
  assert.notEqual(CLAIM_FAILED_EXIT_CODE, REFUSED_EXIT_CODE);
  for (const bad of [["nope"], ["attach", "--agent", "agent-a", "--pid", "5"]]) {
    assert.equal(runLease(bad, { err, lease: make, env: {} }), 0, bad.join(" "));
    assert.match(lines.at(-1), /WARN/);
  }
  assert.equal(runLease(["release", "--agent", "agent-a", "--pid", "200"], { err, lease: make }), 0);
  assert.equal(fs.existsSync(path.join(directory, "agent-a.json")), false);
});

test("parseLeaseArgs: a misspelt flag is refused by name, not read as a missing value", () => {
  assert.throws(() => parseLeaseArgs(["claim", "--agent", "a", "--agnet", "b", "--pid", "5"], {}), /unknown flag --agnet/);
});

test("parseLeaseArgs: instance comes from AIFY_AGENT_LEASE, intent from the mode and how the agent was named", () => {
  const args = parseLeaseArgs(["attach", "--agent", "a", "--pid", "5", "--kind", "gateway"], { AIFY_AGENT_LEASE: "77" });
  assert.deepEqual([args.instance, args.kind, args.intent], [77, "gateway", "start"]);
  assert.equal(parseLeaseArgs(["claim", "--agent", "a", "--pid", "5", "--mode", "managed"], {}).intent, "start");
  assert.equal(parseLeaseArgs(["claim", "--agent", "a", "--pid", "5", "--mode", "resident", "--identity", "flag"], {}).intent, "replace");
  assert.equal(parseLeaseArgs(["claim", "--agent", "a", "--pid", "5", "--mode", "resident", "--identity", "recovered"], {}).intent, "start");
  assert.throws(() => parseLeaseArgs(["claim", "stray"], {}));
});
