#!/usr/bin/env node
// The start sequence and the teardown of one `herdr-aify` invocation.
//
// WHY THESE AND NOTHING ELSE. The sequence has ordering requirements that are invisible when
// violated, and the teardown is the command's entire promise. Every process operation is injected,
// so no test starts a Herdr, a daemon or an agent — which matters more than usual here, where
// running shared infrastructure to test it has twice reaped the operator's live fleet.
//
// FOUR OF THESE TESTS EXIST BECAUSE REVIEW PROVED THE CODE WRONG:
//   - a missing `herdr` was reported as a 20-second readiness timeout, because `child.on("error")`
//     fires on a later tick than the flag that was read;
//   - `pane run` returning ok was treated as the daemon having booted, so an absent `aify-env` left
//     the launcher printing success and blocking for ever in front of an empty pane;
//   - `server stop` returning 0 was reported as "stopped cleanly" while verifying nothing;
//   - the POSIX backstop killed a process GROUP that a non-detached spawn never creates.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { DAEMON_TIMEOUT_MS, HerdrAifyInstance, PHASES, READY_TIMEOUT_MS } from "../lib/herdr-supervisor.mjs";

/** Records every process operation in order, and answers however the test says. */
function fakeProcesses({
  spawnRejects = null,
  readyAfter = 0,
  spaceOk = true,
  envOk = true,
  stopOk = true,
  stillAnswering = false,
} = {}) {
  const calls = [];
  let probes = 0;
  let stopped = false;
  // THE DOUBLE MUST FAIL THE WAY THE REAL THING FAILS, or the test it feeds proves nothing. Node
  // emits `error` on a LATER TICK than the spawn call, so `failed` is FALSE at the moment any
  // synchronous reader would look at it — which is precisely the defect being guarded against. A
  // double that sets `failed` immediately is satisfied by the broken code too, and a mutation run
  // caught exactly that: reverting the fix left this file green until this object was corrected.
  //
  // `exited` stays false for ever as well, because an ENOENT child emits `error` and `close` and
  // never `exit` — which is why the readiness loop's own early-out could not save it either.
  const handle = { pid: 4242, failed: false, error: null, exited: false, started: Promise.resolve() };
  if (spawnRejects) {
    handle.started = Promise.reject(new Error(spawnRejects));
    handle.started.catch(() => {});
    // Set on a later tick, exactly as the real `child.on("error")` handler does.
    queueMicrotask(() => {
      handle.failed = true;
      handle.error = spawnRejects;
    });
  }
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
        if (stopped) return { ok: stillAnswering, error: stillAnswering ? null : "server_not_running" };
        probes += 1;
        return probes > readyAfter ? { ok: true } : { ok: false, error: "server_not_running" };
      }
      if (verb.startsWith("workspace create")) {
        return spaceOk ? { ok: true, paneId: "w1:p1" } : { ok: false, error: "refused" };
      }
      if (verb === "server stop") {
        stopped = true;
        return { ok: stopOk, error: stopOk ? null : "no server" };
      }
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

/** An `io` whose readiness receipt appears after N checks, standing in for the daemon publishing it. */
function fakeIo(receiptAfter = 0) {
  let checks = 0;
  return {
    ...fs,
    existsSync(target) {
      if (String(target).endsWith("ready.json")) {
        checks += 1;
        return checks > receiptAfter;
      }
      return fs.existsSync(target);
    },
  };
}

function instanceIn(processes, { profileRoot } = {}) {
  const root = profileRoot || fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-sup-"));
  return new HerdrAifyInstance({ profileRoot: root, invocation: randomUUID(), platform: "win32", processes, clock: clock() });
}

test("a clean start mints, serves, waits, makes a space, starts the env, then waits for its receipt", async () => {
  const processes = fakeProcesses();
  const instance = instanceIn(processes);
  const started = await instance.start({ io: fakeIo() });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.paneId, "w1:p1");
  assert.ok(fs.existsSync(instance.contextFile), "the instance context was not written");

  const order = processes.calls.map(call => (call.op === "spawn" ? "spawn-server" : call.argv.slice(0, 2).join(" ")));
  assert.equal(order[0], "spawn-server");
  assert.ok(order.indexOf("workspace create") < order.indexOf("pane run"), "the env was started before its space existed");
});

test("the env is started with the context file, led by the flag aify-env requires", async () => {
  const processes = fakeProcesses();
  const instance = instanceIn(processes);
  await instance.start({ io: fakeIo() });
  const launch = processes.calls.find(call => call.argv?.[0] === "pane" && call.argv?.[1] === "run");
  assert.equal(launch.argv[2], "w1:p1", "the env did not land in the first space");
  assert.equal(launch.argv[4], "--instance-context");
  assert.equal(launch.argv[5], instance.contextFile);
  assert.equal(launch.env.AIFY_ADVERTISE, "0", "a dedicated instance that advertised would claim for this host");

  // AND IT MUST BE ON THE SERVER, not only on this CLI call. `pane run` TYPES a command into a shell
  // that already exists, so environment given to the `herdr` process never reaches the daemon.
  // Measured against a real Herdr: aify-env refused with `instance_context: advertisement must be
  // explicitly disabled` while this assertion's CLI-level check was passing.
  const server = processes.calls.find(call => call.op === "spawn");
  assert.equal(server.env.AIFY_ADVERTISE, "0", "the pane inherits the SERVER's environment, and it lacks the flag");
  assert.equal(server.env.AIFY_HERDR_INVOCATION, instance.invocation);
  // And it must not share the host's pane ledger, or a restore in one instance prunes the other's.
  assert.ok(String(launch.env.AIFY_HERDR_LEDGER).includes(instance.invocation));
});

test("a missing herdr names the SERVE phase instead of timing out twenty seconds later", async () => {
  // PROVEN DEFECT: `error` fires a tick after spawn, so the synchronous flag read always saw false,
  // and an ENOENT child never emits `exit` either — so the readiness early-out never fired.
  const processes = fakeProcesses({ spawnRejects: "spawn herdr ENOENT" });
  const started = await instanceIn(processes).start({ io: fakeIo() });
  assert.equal(started.ok, false);
  assert.equal(started.phase, "serve", "a missing binary was not reported as a serve failure");
  assert.match(started.error, /ENOENT/);
  // It must not have gone on to probe readiness at all.
  assert.equal(processes.calls.filter(call => call.argv?.join(" ") === "pane list").length, 0);
});

test("each phase that can fail names itself, and nothing later is attempted", async () => {
  const cases = [
    ["space", { spaceOk: false }],
    ["env", { envOk: false }],
  ];
  for (const [phase, options] of cases) {
    const result = await instanceIn(fakeProcesses(options)).start({ io: fakeIo() });
    assert.equal(result.ok, false);
    assert.equal(result.phase, phase, `expected the failure to name ${phase}`);
    assert.ok(PHASES.includes(result.phase));
  }
  // POSITIVE CONTROL: with nothing broken the same harness succeeds.
  assert.equal((await instanceIn(fakeProcesses()).start({ io: fakeIo() })).ok, true);
});

test("an aify-env that never publishes a receipt is a DAEMON failure, not a success", async () => {
  // PROVEN DEFECT: `pane run` returns ok when aify-env is not on PATH and when the daemon refuses
  // the context, and the launcher then reported the env running and blocked for ever.
  const started = await instanceIn(fakeProcesses()).start({ io: fakeIo(Number.MAX_SAFE_INTEGER) });
  assert.equal(started.ok, false);
  assert.equal(started.phase, "daemon");
  assert.match(started.error, /readiness receipt/);
  assert.ok(DAEMON_TIMEOUT_MS > 0);
});

test("a daemon that is slow to publish is waited for", async () => {
  const started = await instanceIn(fakeProcesses()).start({ io: fakeIo(4) });
  assert.equal(started.ok, true, started.error);
});

test("a server that is slow to answer is waited for, not abandoned", async () => {
  const started = await instanceIn(fakeProcesses({ readyAfter: 5 })).start({ io: fakeIo() });
  assert.equal(started.ok, true, started.error);
  assert.ok(READY_TIMEOUT_MS > 0);
});

test("stopping the server IS the teardown, and it is CONFIRMED rather than assumed", async () => {
  // `server stop` returning 0 says the request was accepted. The promise is that things are gone.
  const processes = fakeProcesses();
  const instance = instanceIn(processes);
  await instance.start({ io: fakeIo() });
  const stopped = await instance.stop({});
  assert.equal(stopped.serverStopped, true);
  assert.equal(stopped.confirmedGone, true, "teardown was reported without checking the server had gone");
  assert.equal(stopped.killed, false, "a clean stop must not also be killed — that races the shutdown");
});

test("a server that accepts the stop and keeps answering is NOT reported as gone", async () => {
  const instance = instanceIn(fakeProcesses({ stillAnswering: true }));
  await instance.start({ io: fakeIo() });
  const stopped = await instance.stop({});
  assert.equal(stopped.serverStopped, true, "the request was still accepted");
  assert.equal(stopped.confirmedGone, false, "a server still answering was reported as gone");
});

test("a server that will not stop IS killed, because the workers are downstream of it", async () => {
  const processes = fakeProcesses({ stopOk: false });
  const instance = instanceIn(processes);
  await instance.start({ io: fakeIo() });
  const stopped = await instance.stop({});
  assert.equal(stopped.serverStopped, false);
  assert.equal(stopped.killed, true, "a Herdr that would not stop was left running with its workers");
  assert.deepEqual(processes.calls.filter(call => call.op === "kill").map(call => call.pid), [4242]);
});

test("teardown is idempotent, so a signal and an exit do not both reach for processes", async () => {
  const processes = fakeProcesses({ stopOk: false });
  const instance = instanceIn(processes);
  await instance.start({ io: fakeIo() });
  await instance.stop({});
  const second = await instance.stop({});
  assert.equal(second.already, true);
  assert.equal(processes.calls.filter(call => call.op === "kill").length, 1, "the second teardown killed again");
});

test("two invocations in one profile never share a root, a socket, a context or a ledger", () => {
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
