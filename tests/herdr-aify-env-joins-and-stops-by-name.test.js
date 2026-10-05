#!/usr/bin/env node
// 0.8.6: `herdr-aify env` detaches like the resident, so a second launch JOINS the running instance, and a stop
// names which of the two it ends.
//
// THE INCIDENT (operator, 2026-10-05): a bare `herdr-aify --stop`, meant for the resident herdr, ended the env
// instance instead -- aify-env and every managed worker -- because it stopped the recorded env invocation first.
// And closing an env terminal ended all managed work; the operator asked for both modes to "work in same manner".

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { incumbentAction, run } from "../bin/herdr-aify.mjs";
import { stopRecorded, stopTarget } from "../lib/herdr-stop.mjs";
import { claimStart, probeOwner, profileOwnerState, writeProfileOwner } from "../lib/herdr-owner.mjs";
import { buildInstanceContext } from "../lib/herdr-instance.mjs";
import { profilePaths, residentPaths } from "../lib/herdr-profile.mjs";

const SEALED_ENV = Object.freeze({ HERDR_BIN_PATH: "herdr-this-test-never-runs" });

test("WHAT A SECOND `herdr-aify env` DOES is decided by the recorded instance's own socket", () => {
  const stale = { owned: false, reason: "stale-pointer", invocation: "i" };
  const live = { owned: true, reason: "live-owner", invocation: "i" };
  for (const [label, state, answer, expected] of [
    ["nothing recorded", { owned: false, reason: "no-pointer" }, null, "start"],
    ["detached and still serving", stale, "serving", "join"],
    ["its launcher still attached elsewhere", live, "serving", "join"],
    ["recorded, and herdr says nothing runs there", stale, "not-running", "start"],
    ["a socket that cannot tell", stale, "unknown", "refuse"],
    ["a live launcher whose server is not serving (starting or stopping)", live, "not-running", "refuse"],
  ]) {
    assert.equal(incumbentAction(state, answer), expected, label);
  }
});

test("A BARE --stop IS THE RESIDENT'S; only `env --stop` reaches the env instance", () => {
  assert.equal(stopTarget(["--stop"]), "resident");
  assert.equal(stopTarget(["stop", "--stop"]), "resident", "herdr's own spelling, mapped to the flag by main");
  assert.equal(stopTarget(["env", "--stop"]), "env");
});

function recorded() {
  // Short, because a run binds real sockets under this root (see herdr-aify-attaches-a-tui).
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  const invocation = randomUUID();
  // A pointer whose owner endpoint answers nothing: the launcher that wrote it has detached and gone.
  writeProfileOwner(profileRoot, { invocation, ownerEndpoint: path.join(profileRoot, "gone.sock"), pid: 1 });
  return { profileRoot, invocation };
}

function fakeFor(profileRoot, invocation, events) {
  return {
    context: buildInstanceContext({ profileRoot, invocation, profileRef: "integrated", platform: process.platform }),
    profile: { socketPath: path.join(profileRoot, "s.sock") },
    start: async () => {
      events.push("start");
      return { ok: true, paneId: "w1:p1" };
    },
    attachTui: () => {
      events.push("attach");
      return { exited: Promise.resolve(0), kill: () => {} };
    },
    whenServerExits: () => new Promise(() => {}),
    stop: async () => {
      events.push("stop");
      return { everServed: true, confirmedGone: true };
    },
  };
}

test("A SECOND LAUNCH JOINS the instance that is still serving: it attaches, and starts and stops nothing", async () => {
  const { profileRoot, invocation } = recorded();
  const events = [];
  const made = [];
  const asked = [];
  const code = await run({
    profileRoot, env: SEALED_ENV, attaching: true, withEnv: true,
    makeInstance: ({ invocation: id }) => (made.push(id), fakeFor(profileRoot, id, events)),
    cli: (argv, { env }) => (asked.push(`${argv.join(" ")} @${env.HERDR_SOCKET_PATH}`), { ok: true }),
  });
  assert.equal(code, 0);
  // THE RECORDED INSTANCE'S socket: asked without it, the CLI reaches whatever herdr the operator's own shell names.
  const recordedSocket = profilePaths({ profileRoot, invocation }).socketPath;
  assert.deepEqual(asked, [`pane list @${recordedSocket}`], "the recorded instance's own socket was not asked");
  assert.deepEqual(made, [invocation], "it did not join the recorded invocation");
  assert.deepEqual(events, ["attach"], "a joining launch started, or stopped, an instance");
});

test("headless, a second launch reports the running instance and changes nothing", async () => {
  const { profileRoot, invocation } = recorded();
  const events = [];
  const code = await run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true,
    makeInstance: ({ invocation: id }) => fakeFor(profileRoot, id, events),
    cli: () => ({ ok: true }),
  });
  assert.equal(code, 0);
  assert.deepEqual(events, [], `instance ${invocation} was touched`);
});

test("CONTROL: a recorded instance herdr says is gone is replaced by a new one, as before", { timeout: 15000 }, async () => {
  const { profileRoot, invocation } = recorded();
  const events = [];
  const made = [];
  const code = await run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true,
    makeInstance: ({ invocation: id }) => (made.push(id), fakeFor(profileRoot, id, events)),
    cli: () => ({ ok: false, code: "server_not_running" }),
  });
  assert.equal(code, 0);
  assert.equal(made.length, 1);
  assert.notEqual(made[0], invocation, "the gone instance was joined rather than replaced");
  assert.deepEqual(events, ["start"], "the new instance was not started, or was stopped at once");
  // DETACHING KEEPS THE POINTER: it is the only handle a later launch or `env --stop` has on the instance.
  assert.equal((await profileOwnerState(profileRoot)).invocation, made[0], "the detached instance is no longer recorded");
});

test("a recorded instance whose socket cannot tell is refused: nothing joined, nothing started", async () => {
  const { profileRoot } = recorded();
  const events = [];
  const code = await run({
    profileRoot, env: SEALED_ENV, attaching: true, withEnv: true,
    makeInstance: ({ invocation: id }) => fakeFor(profileRoot, id, events),
    cli: () => ({ ok: false, error: "timed out" }),
  });
  assert.equal(code, 3);
  assert.deepEqual(events, []);
});

test("A BARE --stop ADDRESSES ONLY THE RESIDENT'S SOCKET, even with an env instance recorded; `env --stop` only the env's", async () => {
  const { profileRoot, invocation } = recorded();
  const residentSocket = residentPaths({ profileRoot }).socketPath;
  const envSocket = profilePaths({ profileRoot, invocation }).socketPath;
  assert.notEqual(residentSocket, envSocket, "control: the two instances have different sockets");
  const callsFor = async (target) => {
    const calls = [];
    // Serving until asked to stop, then gone: what a real server does.
    let stopped = false;
    const cli = (argv, { env }) => {
      calls.push(`${argv.join(" ")} @${env.HERDR_SOCKET_PATH === residentSocket ? "resident" : env.HERDR_SOCKET_PATH === envSocket ? "env" : "other"}`);
      if (argv[0] === "server") { stopped = true; return { ok: true }; }
      return stopped ? { ok: false, code: "server_not_running" } : { ok: true };
    };
    const code = await stopRecorded({ profileRoot, env: SEALED_ENV, target, cli });
    return { code, calls };
  };
  const bare = await callsFor("resident");
  assert.equal(bare.code, 0);
  assert.deepEqual(bare.calls, ["pane list @resident", "server stop @resident", "pane list @resident"], "a bare stop reached the env instance");
  const named = await callsFor("env");
  assert.equal(named.code, 0);
  assert.deepEqual(named.calls, ["server stop @env", "pane list @env"], "`env --stop` reached something other than the env instance");
});

test("A FAILED `env --stop` KEEPS THE INSTANCE RECORDED, so the next launch joins it rather than starting a second", async () => {
  // Review of 0.8.6: the pointer was cleared whatever the stop's outcome, and it is the only handle on a detached
  // instance -- the next `herdr-aify env` read "nothing recorded" and started a second aify-env beside the first.
  const { profileRoot, invocation } = recorded();
  const stillServing = () => ({ ok: true });
  const code = await stopRecorded({
    profileRoot, env: SEALED_ENV, target: "env", sleep: async () => {},
    cli: (argv) => (argv[0] === "server" ? { ok: false, error: "refused" } : stillServing()),
  });
  assert.equal(code, 1, "a stop that did not end the instance reported success");
  assert.equal((await profileOwnerState(profileRoot)).invocation, invocation, "the instance it could not stop is no longer recorded");
  const events = [];
  const made = [];
  const next = await run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true, onSignal: () => {},
    makeInstance: ({ invocation: id }) => (made.push(id), fakeFor(profileRoot, id, events)),
    cli: stillServing,
  });
  assert.equal(next, 0);
  assert.deepEqual(made, [invocation], "the next launch did not join the instance still serving");
  assert.deepEqual(events, [], "a second instance was started beside the one the stop could not end");
});

test("A SERVER THAT TAKES A MOMENT TO EXIT is waited for: confirmed gone, and only then forgotten", async () => {
  const { profileRoot } = recorded();
  let asksAfterStop = 0;
  const code = await stopRecorded({
    profileRoot, env: SEALED_ENV, target: "env", sleep: async () => {},
    cli: (argv) => {
      if (argv[0] === "server") return { ok: true };
      asksAfterStop += 1;
      return asksAfterStop <= 3 ? { ok: false, error: "timed out" } : { ok: false, code: "server_not_running" };
    },
  });
  assert.equal(code, 0, "a server still exiting when first asked was reported as not gone");
  assert.equal((await profileOwnerState(profileRoot)).invocation, undefined, "a stopped instance is still recorded");
});

test("TWO LAUNCHES AT ONCE on an empty profile start ONE instance; the other is refused, not started", async () => {
  // Review of 0.8.6: both read "nothing recorded" before either wrote the pointer, so both started, and the one the
  // pointer did not name could never be joined or stopped again.
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  const events = [];
  const launch = () => run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true, onSignal: () => {},
    makeInstance: ({ invocation: id }) => fakeFor(profileRoot, id, events),
    cli: () => ({ ok: false, code: "server_not_running" }),
  });
  const codes = await Promise.all([launch(), launch()]);
  assert.deepEqual(codes.sort(), [0, 3]);
  assert.deepEqual(events, ["start"], "both launches started an instance");
  // CONTROL: the lock is released once the instance is up, so the next launch decides (here: joins) rather than
  // being refused for ever.
  const later = await run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true, onSignal: () => {},
    makeInstance: ({ invocation: id }) => fakeFor(profileRoot, id, events),
    cli: () => ({ ok: true }),
  });
  assert.equal(later, 0);
  assert.deepEqual(events, ["start"]);
});

test("the start lock: held, refused while its holder lives, taken over from a dead one, released only by its own", () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  const lock = path.join(profileRoot, "env-starting.lock");
  const first = claimStart(profileRoot, { pid: 111, alive: () => true });
  assert.equal(first.ok, true);
  assert.deepEqual(claimStart(profileRoot, { pid: 222, alive: () => true }), { ok: false, holder: 111, file: lock });
  assert.equal(claimStart(profileRoot, { pid: 222, alive: pid => pid !== 111 }).ok, true, "a lock whose holder died blocks every later launch");
  first.release();
  assert.equal(fs.readFileSync(lock, "utf8").trim(), "222", "a launch released a lock another launch now holds");
  fs.writeFileSync(lock, "");
  assert.equal(claimStart(profileRoot, { pid: 333, alive: () => false }).ok, false, "a claim still being written was taken over");
  assert.equal(fs.existsSync(lock), true);
});

/** Lets the run reach the point the test is waiting for. */
async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "the run never reached the point this test waits for");
}

test("A SIGNAL BEFORE THE INSTANCE IS UP takes the half-started instance down with the launcher", async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  const events = [];
  let signal;
  let exited;
  const exitCode = new Promise(resolve => {
    exited = resolve;
  });
  let startFinishes;
  const running = run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true,
    onSignal: handler => {
      signal = handler;
    },
    exit: exited,
    makeInstance: ({ invocation: id }) => ({
      ...fakeFor(profileRoot, id, events),
      start: () => (events.push("start"), new Promise(resolve => {
        startFinishes = () => resolve({ ok: false, phase: "ready", error: "stopped" });
      })),
    }),
    cli: () => ({ ok: false, code: "server_not_running" }),
  });
  await until(() => events.includes("start"));
  signal();
  assert.equal(await exitCode, 0);
  assert.deepEqual(events, ["start", "stop"], "a half-started instance was left running when the launcher was signalled");
  assert.equal((await profileOwnerState(profileRoot)).invocation, undefined, "the torn-down instance is still recorded");
  startFinishes();
  await running;
  assert.deepEqual(events, ["start", "stop"], "the teardown ran twice");
});

test("A SIGNAL ONCE IT IS UP DETACHES, as leaving the session does: nothing stopped, the instance still recorded", async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  const events = [];
  const made = [];
  let signal;
  let exited;
  const exitCode = new Promise(resolve => {
    exited = resolve;
  });
  run({
    profileRoot, env: SEALED_ENV, attaching: true, withEnv: true,
    onSignal: handler => {
      signal = handler;
    },
    exit: exited,
    makeInstance: ({ invocation: id }) => (made.push(id), {
      ...fakeFor(profileRoot, id, events),
      attachTui: () => (events.push("attach"), { exited: new Promise(() => {}), kill: () => events.push("client killed") }),
    }),
    cli: () => ({ ok: false, code: "server_not_running" }),
  });
  await until(() => events.includes("attach"));
  signal();
  assert.equal(await exitCode, 0);
  assert.deepEqual(events, ["start", "attach"], "a closed terminal ended the instance it was attached to");
  assert.equal((await profileOwnerState(profileRoot)).invocation, made[0], "the detached instance is no longer recorded");
});

test("A POINTER THAT CANNOT BE WRITTEN fails the launch and frees the start lock, rather than blocking every later one", async () => {
  // Review of 0.8.6: the throw left the owner listening (so the launcher never exited) and the lock held, so every
  // other `herdr-aify env` on the host was refused until that process was killed. This file finishing at all is the
  // owner's half: an endpoint left listening keeps the test process alive.
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  fs.mkdirSync(path.join(profileRoot, "owner.json"));
  const events = [];
  const made = [];
  await assert.rejects(run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true, onSignal: () => {},
    makeInstance: ({ invocation: id }) => (made.push(fakeFor(profileRoot, id, events)), made.at(-1)),
    cli: () => ({ ok: false, code: "server_not_running" }),
  }));
  assert.deepEqual(events, [], "an instance was started with no pointer to find it by");
  await assertOwnerClosed(made[0]);
  const next = claimStart(profileRoot);
  assert.equal(next.ok, true, "the failed launch still holds the start lock");
  next.release();
});

test("A START THAT THROWS is torn down like a failed one: nothing left running, the lock free", async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aj-"));
  const events = [];
  const code = await run({
    profileRoot, env: SEALED_ENV, attaching: false, withEnv: true, onSignal: () => {},
    makeInstance: ({ invocation: id }) => ({
      ...fakeFor(profileRoot, id, events),
      start: async () => {
        events.push("start");
        throw new Error("boom");
      },
    }),
    cli: () => ({ ok: false, code: "server_not_running" }),
  }).catch(err => `rejected: ${err.message}`);
  assert.equal(code, 1, "a throwing start escaped the teardown");
  assert.deepEqual(events, ["start", "stop"]);
  const next = claimStart(profileRoot);
  assert.equal(next.ok, true, "the failed launch still holds the start lock");
  next.release();
});

/**
 * The launcher's owner endpoint answers no more. Asked directly, because left open it only shows as a test file that
 * never exits -- and a hang is reported as nothing at all.
 */
async function assertOwnerClosed(instance) {
  const { invocation, ownerEndpoint } = instance.context;
  const answers = await probeOwner(ownerEndpoint, { invocation, scope: `herdr-${invocation}` }, { timeoutMs: 500 });
  assert.equal(answers, false, "the failed launch left its owner endpoint listening, so the launcher cannot exit");
}
