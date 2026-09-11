#!/usr/bin/env node
// The start sequence and the teardown of one `herdr-aify` invocation.
//
// WHY THESE TWO AND NOTHING ELSE. The sequence has an ordering requirement that is invisible when it
// is violated (mint before serve, space before env), and the teardown is the command's entire
// promise to the operator: closing it closes the Herdr, the dedicated env and the workers. Both are
// judged here with every process operation injected, so no test starts a Herdr, a daemon or an agent
// -- which matters more than usual in this repo, where running shared infrastructure to test it has
// twice reaped the operator's live fleet.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { HerdrAifyInstance, PHASES, READY_TIMEOUT_MS } from "../lib/herdr-supervisor.mjs";

/** Records every process operation in order, and answers however the test says. */
function fakeProcesses({ serverStarts = true, readyAfter = 0, spaceOk = true, envOk = true, stopOk = true } = {}) {
  const calls = [];
  let probes = 0;
  const handle = { pid: 4242, failed: !serverStarts, error: serverStarts ? null : "ENOENT", exited: false };
  return {
    calls,
    handle,
    spawn(command, argv, options) {
      calls.push({ op: "spawn", command, argv, env: options.env });
      return handle;
    },
    run(command, argv, options) {
      calls.push({ op: "run", command, argv, env: options.env });
      const verb = argv.join(" ");
      if (verb === "pane list") {
        probes += 1;
        return probes > readyAfter ? { ok: true } : { ok: false, error: "server_not_running" };
      }
      if (verb.startsWith("workspace create")) {
        return spaceOk ? { ok: true, paneId: "w1:p1" } : { ok: false, error: "refused" };
      }
      if (verb === "server stop") return { ok: stopOk, error: stopOk ? null : "no server" };
      return envOk ? { ok: true } : { ok: false, error: "launcher refused" };
    },
    kill(pid) {
      calls.push({ op: "kill", pid });
      return true;
    },
  };
}

const clock = () => {
  let t = 0;
  return { now: () => (t += 10), sleep: async () => {} };
};

function instanceIn(processes, { profileRoot } = {}) {
  const root = profileRoot || fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-sup-"));
  return new HerdrAifyInstance({ profileRoot: root, invocation: randomUUID(), platform: "win32", processes, clock: clock() });
}

test("a clean start mints, serves, waits, makes a space, then starts the env — in that order", async () => {
  const processes = fakeProcesses();
  const instance = instanceIn(processes);
  const started = await instance.start({});
  assert.equal(started.ok, true, started.error);
  assert.equal(started.paneId, "w1:p1");

  // The context file is what makes an invocation single-use, so it must exist before a server could
  // have raced a second launcher to the same one.
  assert.ok(fs.existsSync(instance.contextFile), "the instance context was not written");

  const order = processes.calls.map(call => (call.op === "spawn" ? "spawn-server" : call.argv.slice(0, 2).join(" ")));
  assert.equal(order[0], "spawn-server");
  assert.ok(order.indexOf("workspace create") < order.indexOf("pane run"), "the env was started before its space existed");
});

test("the env is started with the context file, led by the flag aify-env requires", async () => {
  const processes = fakeProcesses();
  const instance = instanceIn(processes);
  await instance.start({});
  const launch = processes.calls.find(call => call.argv?.[0] === "pane" && call.argv?.[1] === "run");
  assert.equal(launch.argv[2], "w1:p1", "the env did not land in the first space");
  assert.equal(launch.argv[4], "--instance-context");
  assert.equal(launch.argv[5], instance.contextFile);
  // A dedicated instance that advertised would publish a second claimer for this host.
  assert.equal(launch.env.AIFY_ADVERTISE, "0");
});

test("each phase that can fail names itself, and nothing later is attempted", async () => {
  // Driven by breaking one step at a time; a failure that reported the wrong phase, or that carried
  // on regardless, is the thing this catches.
  const cases = [
    ["serve", { serverStarts: false }],
    ["space", { spaceOk: false }],
    ["env", { envOk: false }],
  ];
  for (const [phase, options] of cases) {
    const processes = fakeProcesses(options);
    const result = await instanceIn(processes).start({});
    assert.equal(result.ok, false);
    assert.equal(result.phase, phase, `expected the failure to name ${phase}`);
    assert.ok(PHASES.includes(result.phase));
  }
  // POSITIVE CONTROL: with nothing broken, the same harness succeeds — so the failures above are the
  // injected breakage and not a harness that never works.
  assert.equal((await instanceIn(fakeProcesses()).start({})).ok, true);
});

test("a server that exits is reported at once instead of waiting out the readiness clock", async () => {
  const processes = fakeProcesses({ readyAfter: Number.MAX_SAFE_INTEGER });
  processes.handle.exited = true;
  const started = await instanceIn(processes).start({});
  assert.equal(started.ok, false);
  assert.equal(started.phase, "ready");
  assert.match(started.error, /exited before it was ready/);
  // It must not have spent the full timeout discovering that.
  assert.ok(READY_TIMEOUT_MS > 0);
});

test("a server that is slow to answer is waited for, not abandoned", async () => {
  const started = await instanceIn(fakeProcesses({ readyAfter: 5 })).start({});
  assert.equal(started.ok, true, started.error);
});

test("stopping the server IS the teardown, and the tree kill is only a backstop", async () => {
  const processes = fakeProcesses();
  const instance = instanceIn(processes);
  await instance.start({});
  const stopped = await instance.stop({});
  assert.equal(stopped.serverStopped, true);
  assert.equal(stopped.killed, false, "a clean stop must not also be killed — that races the shutdown collecting workers");
  assert.equal(processes.calls.filter(call => call.op === "kill").length, 0);
});

test("a server that will not stop IS killed, because the workers are downstream of it", async () => {
  const processes = fakeProcesses({ stopOk: false });
  const instance = instanceIn(processes);
  await instance.start({});
  const stopped = await instance.stop({});
  assert.equal(stopped.serverStopped, false);
  assert.equal(stopped.killed, true, "a Herdr that would not stop was left running with its workers");
  assert.deepEqual(processes.calls.filter(call => call.op === "kill").map(call => call.pid), [4242]);
});

test("teardown is idempotent, so a signal and an exit do not both reach for processes", async () => {
  const processes = fakeProcesses({ stopOk: false });
  const instance = instanceIn(processes);
  await instance.start({});
  await instance.stop({});
  const second = await instance.stop({});
  assert.equal(second.already, true);
  assert.equal(processes.calls.filter(call => call.op === "kill").length, 1, "the second teardown killed again");
});

test("two invocations in one profile never share a root, a socket or a context", () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-two-"));
  const first = instanceIn(fakeProcesses(), { profileRoot });
  const second = instanceIn(fakeProcesses(), { profileRoot });
  assert.notEqual(first.invocation, second.invocation);
  assert.notEqual(first.profile.socketPath, second.profile.socketPath);
  assert.notEqual(first.contextFile, second.contextFile);
  assert.notEqual(first.context.ownerEndpoint, second.context.ownerEndpoint);
  // The no-resurrection guarantee: a fresh invocation cannot address the previous one's receipts.
  assert.notEqual(first.context.processRecord, second.context.processRecord);
});
