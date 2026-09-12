#!/usr/bin/env node
// `herdr-aify` must put a Herdr TUI in the operator's terminal.
//
// THE DEFECT THIS EXISTS FOR, reported by the operator on their second attempt at using the feature:
//
//   herdr-aify: aify-env in w1:p1; close this command to end all of it
//   "...and thats all, nothing opens etc. and i cannot ctrl-c it also"
//
// `herdr server` is a HEADLESS DAEMON. The thing an operator calls "Herdr" is the client that
// attaches to it, which is what a bare `herdr` runs. The command started the server, put aify-env in
// its first space, printed three lines and then sat on a promise — owning a console it never used,
// in front of a terminal where nothing had opened and nothing could be typed. Every test passed,
// every phase reported ok, and the feature was absent.
//
// WHAT IS ASSERTED. That a client is started, that it is pointed at THIS instance's socket rather
// than the operator's ordinary Herdr, and that the command ends when the session is left. The
// rendering is Herdr's and is not this package's to test.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { shouldAttach } from "../bin/herdr-aify.mjs";
import { HerdrAifyInstance } from "../lib/herdr-supervisor.mjs";
import { buildInstanceContext } from "../lib/herdr-instance.mjs";

function instanceWith(processes) {
  return new HerdrAifyInstance({
    profileRoot: fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-attach-")),
    invocation: randomUUID(),
    platform: "win32",
    processes,
    clock: { now: (t => () => (t += 10))(0), sleep: async () => {} },
  });
}

test("THE MISSING HALF: a client is started, and it is pointed at THIS instance", () => {
  const calls = [];
  const instance = instanceWith({
    spawn: () => ({ pid: 1, failed: false, exited: false, started: Promise.resolve() }),
    run: () => ({ ok: true }),
    kill: () => true,
    attach: (command, argv, { env }) => {
      calls.push({ command, argv, env });
      return { exited: Promise.resolve(0), kill: () => {} };
    },
  });

  instance.attachTui({ env: {}, herdrBin: "herdr" });
  assert.equal(calls.length, 1, "no TUI was started — this is the reported defect");
  assert.deepEqual(calls[0].argv, [], "a bare `herdr` is the client; a subcommand is not it");
  // THE DECISIVE ONE. A client resolving the default socket attaches to the operator's ORDINARY
  // Herdr, which is the one thing this command must never touch.
  assert.equal(calls[0].env.HERDR_SOCKET_PATH, instance.profile.socketPath);
  assert.equal(calls[0].env.XDG_CONFIG_HOME, instance.profile.configHome);
});

test("a terminal is required, and BOTH streams are, because a TUI draws and reads", () => {
  assert.equal(shouldAttach({ io: { stdout: { isTTY: true }, stdin: { isTTY: true } } }), true);
  assert.equal(shouldAttach({ io: { stdout: { isTTY: false }, stdin: { isTTY: true } } }), false);
  assert.equal(shouldAttach({ io: { stdout: { isTTY: true }, stdin: { isTTY: false } } }), false);
  assert.equal(shouldAttach({ io: {} }), false, "a piped run must stay headless rather than half-work");
  // The escape hatch, so a scripted run is deterministic instead of depending on how it was invoked.
  assert.equal(
    shouldAttach({ argv: ["--no-attach"], io: { stdout: { isTTY: true }, stdin: { isTTY: true } } }),
    false,
  );
});

test("the real attach hands over this console, which is what makes Ctrl-C the TUI's", async () => {
  // Driven through the REAL `processes.attach`, because the operator's complaint was about who owns
  // the terminal — and that is decided by the stdio option, which a fake would simply not have.
  const { processes } = await import("../bin/herdr-aify.mjs");
  assert.equal(typeof processes.attach, "function", "there is no attach operation at all");
  const client = processes.attach(process.execPath, ["-e", "process.exit(7)"], { env: process.env });
  assert.equal(await client.exited, 7, "the launcher cannot tell when the session was left");
});

test("a client that cannot start resolves rather than hanging the command for ever", async () => {
  const { processes } = await import("../bin/herdr-aify.mjs");
  const client = processes.attach("herdr-that-is-not-installed", [], { env: process.env });
  assert.equal(await client.exited, null, "a failed attach left the launcher waiting on nothing");
});

test("THE CALL SITE: a run with a terminal ATTACHES, and ends when the session is left", { timeout: 15000 }, async () => {
  // THE TEST THAT WAS MISSING, and its absence is the whole incident. `attachTui` proven in
  // isolation says nothing about whether `run` ever calls it -- and it did not, for the feature's
  // entire life, while every phase reported ok and the suite was green.
  const { run } = await import("../bin/herdr-aify.mjs");
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-callsite-"));
  const invocation = randomUUID();
  const events = [];
  let endSession = null;
  const fake = {
    // A REAL context, because the owner this run starts refuses a hand-written one -- and a fake
    // that cannot be refused would not be exercising the run this test is about.
    context: buildInstanceContext({ profileRoot, invocation, profileRef: "integrated", platform: "win32" }),
    profile: { socketPath: path.join(profileRoot, "s.sock") },
    start: async () => {
      events.push("start");
      return { ok: true, paneId: "w1:p1" };
    },
    attachTui: () => {
      events.push("attach");
      return { exited: new Promise(resolve => (endSession = resolve)), kill: () => {} };
    },
    // A server that never goes away on its own, so the ONLY thing that can end this run is the
    // session being left -- which is the behaviour under test.
    whenServerExits: () => new Promise(() => {}),
    stop: async () => {
      events.push("stop");
      return { everServed: true, serverStopped: true, killed: false, confirmedGone: true };
    },
  };

  const finished = run({ profileRoot, env: {}, attaching: true, makeInstance: () => fake });
  finished.catch(() => {});
  for (let i = 0; i < 200 && !endSession; i += 1) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, ["start", "attach"], "the run never attached a TUI");

  endSession(0);                       // the operator leaves the Herdr session
  await Promise.race([finished, new Promise(r => setTimeout(r, 3000))]);
  assert.ok(events.includes("stop"), "leaving the session did not end the instance");
});

test("NEGATIVE CONTROL: with no terminal the same run stays headless", { timeout: 15000 }, async () => {
  // Without this, a run that attached unconditionally would pass the test above -- and would spray a
  // TUI into whatever pipe a scripted caller was reading.
  const { run } = await import("../bin/herdr-aify.mjs");
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-headless-"));
  const invocation = randomUUID();
  const events = [];
  let stopServer = null;
  const fake = {
    // A REAL context, because the owner this run starts refuses a hand-written one -- and a fake
    // that cannot be refused would not be exercising the run this test is about.
    context: buildInstanceContext({ profileRoot, invocation, profileRef: "integrated", platform: "win32" }),
    profile: { socketPath: path.join(profileRoot, "s.sock") },
    start: async () => ({ ok: true, paneId: "w1:p1" }),
    attachTui: () => {
      events.push("attach");
      return { exited: Promise.resolve(0), kill: () => {} };
    },
    whenServerExits: () => new Promise(resolve => (stopServer = resolve)),
    stop: async () => ({ everServed: true, serverStopped: true, killed: false, confirmedGone: true }),
  };

  const finished = run({ profileRoot, env: {}, attaching: false, makeInstance: () => fake });
  finished.catch(() => {});
  for (let i = 0; i < 200 && !stopServer; i += 1) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, [], "a headless run started a TUI into a pipe");
  stopServer();
  await Promise.race([finished, new Promise(r => setTimeout(r, 3000))]);
});
