#!/usr/bin/env node
// What `herdr-aify` tells the operator when it shuts down.
//
// THE DEFECT THIS EXISTS FOR, and it was visible in the first end-to-end run of the finished command:
//
//   herdr-aify: stopped (server did not stop, confirmed gone)
//
// Both clauses came from real flags and the sentence was still false. `herdr-aify --stop` from
// another shell had ended the server; the launcher woke BECAUSE its child exited, then asked a dead
// socket to stop and reported the refusal as a fault. The teardown had gone exactly to plan.
//
// WHY A TEST AND NOT A CAREFUL EDIT. The line is assembled from four booleans, so it has sixteen
// readings and only some are reachable. A wording fix proves one of them. This drives the real
// function over the combinations the supervisor can actually produce, and asserts the property that
// matters: a line must never claim a failure that did not happen.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { teardownLine } from "../bin/herdr-aify.mjs";
import { HerdrAifyInstance } from "../lib/herdr-supervisor.mjs";

test("THE OPERATOR'S LINE: a server that went first is not a server that refused to stop", () => {
  const line = teardownLine({ everServed: true, alreadyGone: true, serverStopped: false, killed: false, confirmedGone: true });
  assert.equal(line, "herdr-aify: stopped (the server had already exited, confirmed gone)");
  assert.doesNotMatch(line, /did not stop|refused/, "the line reported a failure that did not happen");
});

test("a clean stop, a refused stop and a killed tree each say what they are", () => {
  assert.match(
    teardownLine({ everServed: true, serverStopped: true, killed: false, confirmedGone: true }),
    /server stopped cleanly, confirmed gone/,
  );
  assert.match(
    teardownLine({ everServed: true, serverStopped: false, killed: true, confirmedGone: true }),
    /server refused to stop, tree killed, confirmed gone/,
  );
  assert.match(
    teardownLine({ everServed: true, serverStopped: false, killed: false, confirmedGone: true }),
    /server refused to stop, confirmed gone/,
  );
});

test("a server still answering is the one case that must alarm, however the request went", () => {
  for (const result of [
    { everServed: true, serverStopped: true, killed: false, confirmedGone: false },
    { everServed: true, serverStopped: false, killed: true, confirmedGone: false },
    { everServed: true, alreadyGone: false, serverStopped: false, killed: false, confirmedGone: false },
  ]) {
    assert.match(teardownLine(result), /STILL ANSWERING/, "a live server was reported as torn down");
  }
});

test("nothing started is its own answer, not a failed stop", () => {
  const line = teardownLine({ everServed: false, serverStopped: false, killed: false, confirmedGone: true });
  assert.equal(line, "herdr-aify: nothing was started, so there is nothing to stop");
  assert.equal(teardownLine(null), line, "a teardown with no result must not print a fault either");
});

test("THE SOURCE OF THE FLAGS, so this is not a test of a hand-written object", async () => {
  // An expectation derived from a fabricated result would agree with any code. This drives the real
  // supervisor into the state the operator hit -- a server that exited on its own -- and asserts on
  // the line its OWN result produces.
  const calls = [];
  const child = { once: () => {} };
  const handle = { pid: 4242, failed: false, error: null, exited: false, started: Promise.resolve(), child };
  const processes = {
    spawn: () => handle,
    run: (command, argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "workspace") return { ok: true, paneId: "w1:p1" };
      return { ok: true };
    },
    kill: pid => {
      calls.push(`kill ${pid}`);
      return true;
    },
  };
  const io = { ...fs, existsSync: target => (String(target).endsWith("ready.json") ? true : fs.existsSync(target)) };
  const instance = new HerdrAifyInstance({
    profileRoot: fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-line-")),
    invocation: randomUUID(),
    platform: "win32",
    processes,
    clock: { now: (t => () => (t += 10))(0), sleep: async () => {} },
  });
  assert.equal((await instance.start({ io })).ok, true);

  // The server goes away on its own, exactly as `herdr-aify --stop` from another shell leaves it.
  handle.exited = true;
  const result = await instance.stop({});
  assert.equal(result.alreadyGone, true, "the supervisor did not notice the server had gone");
  assert.equal(teardownLine(result), "herdr-aify: stopped (the server had already exited, confirmed gone)");

  // AND IT MUST NOT HAVE REACHED FOR THE PID. That process is gone; on Windows the number belongs to
  // whatever is issued it next.
  assert.equal(calls.some(call => call.startsWith("kill ")), false, "a dead server's pid was killed");
  assert.equal(calls.includes("server stop"), false, "a dead socket was asked to stop");
});
