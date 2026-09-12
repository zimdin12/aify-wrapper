#!/usr/bin/env node
// `herdr-aify` and `herdr-aify env` are two different things, and the word decides which.
//
// THE DEFECT THIS EXISTS FOR. The operator's very first use of this feature was `herdr-aify env`,
// and the argument reached NOTHING: any non-flag word was discarded and every launch started a
// dedicated aify-env, including the launches meant to be a plain Herdr. Their correction:
//
//   "herdr-aify env is for managed ones with env, herdr-aify without env should open herdr that has
//    our aify-wrapper support (so that my claude-aify could autostart etc) and without env it is
//    meant for resident sessions basically"
//
// A command that silently discards an argument is worse than one that refuses it, because the
// operator cannot learn it was never read. So an unknown word is now a refusal with the usage.
//
// AND THE PLAIN MODE NEEDS THE PLUGIN. The plugin an operator links once with `aify-herdr-pane
// install` lives in their ORDINARY Herdr's config root; this instance has its own by design. Without
// linking it here, a `claude-aify` started inside claims no pane and nothing restores it -- which is
// the entire point of the plain mode.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { modeFor } from "../bin/herdr-aify.mjs";
import { HerdrAifyInstance } from "../lib/herdr-supervisor.mjs";

test("THE WORD THAT WAS IGNORED: `env` asks for a daemon, nothing asks for none", () => {
  assert.deepEqual(modeFor([]), { ok: true, withEnv: false });
  assert.deepEqual(modeFor(["env"]), { ok: true, withEnv: true });
  // Flags are not modes, and must not change which of the two this is.
  assert.deepEqual(modeFor(["--no-attach"]), { ok: true, withEnv: false });
  assert.deepEqual(modeFor(["env", "--no-attach"]), { ok: true, withEnv: true });
});

test("an argument this command does not understand is REFUSED, never discarded", () => {
  for (const argv of [["envs"], ["bogus"], ["env", "extra"], ["Env"]]) {
    const mode = modeFor(argv);
    assert.equal(mode.ok, false, `${argv.join(" ")} was silently accepted`);
    assert.match(mode.error, /expected "env" or nothing/);
  }
});

/** An instance whose every process operation is recorded, so the two modes can be compared. */
function recorded() {
  const calls = [];
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-mode-"));
  const instance = new HerdrAifyInstance({
    profileRoot,
    invocation: randomUUID(),
    platform: "win32",
    processes: {
      spawn: () => ({ pid: 1, failed: false, exited: false, started: Promise.resolve() }),
      run: (_c, argv) => {
        calls.push(argv.join(" "));
        return argv[0] === "workspace" ? { ok: true, paneId: "w1:p1" } : { ok: true };
      },
      kill: () => true,
      attach: () => ({ exited: Promise.resolve(0), kill: () => {} }),
    },
    clock: { now: (t => () => (t += 10))(0), sleep: async () => {} },
  });
  const io = { ...fs, existsSync: t => (String(t).endsWith("ready.json") ? true : fs.existsSync(t)) };
  return { instance, calls, io };
}

test("PLAIN MODE STARTS NO DAEMON, which is the operator's whole distinction", async () => {
  const { instance, calls, io } = recorded();
  const started = await instance.start({ io, withEnv: false, pluginDir: "C:/plugins/aify" });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.withEnv, false);
  assert.equal(started.paneId, null, "a plain instance reported a pane it never made");
  assert.equal(calls.some(c => c.startsWith("workspace create")), false, "it made the aify-env space anyway");
  assert.equal(calls.some(c => c.startsWith("pane run")), false, "it started a daemon nobody asked for");
});

test("PLAIN MODE LINKS THE PLUGIN, or claude-aify claims nothing and is restored by nothing", async () => {
  const { instance, calls, io } = recorded();
  await instance.start({ io, withEnv: false, pluginDir: "C:/plugins/aify" });
  assert.ok(calls.includes("plugin link C:/plugins/aify"), "the wrapper plugin was not linked into this profile");
  assert.equal(instance.pluginLinked, true);
});

test("ENV MODE still does everything it did, and links the plugin too", async () => {
  const { instance, calls, io } = recorded();
  const started = await instance.start({ io, withEnv: true, pluginDir: "C:/plugins/aify" });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.paneId, "w1:p1");
  assert.ok(calls.some(c => c.startsWith("workspace create")));
  assert.ok(calls.some(c => c.startsWith("pane run w1:p1 aify-env")), "the dedicated env was not started");
  assert.ok(calls.includes("plugin link C:/plugins/aify"));
  // ORDERING: the plugin must be linked before anything runs in a pane, or the first pane misses it.
  assert.ok(calls.indexOf("plugin link C:/plugins/aify") < calls.findIndex(c => c.startsWith("pane run")));
});

test("a plugin that will not link is reported, and does not fail the launch", async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-mode-"));
  const instance = new HerdrAifyInstance({
    profileRoot,
    invocation: randomUUID(),
    platform: "win32",
    processes: {
      spawn: () => ({ pid: 1, failed: false, exited: false, started: Promise.resolve() }),
      run: (_c, argv) => (argv[0] === "plugin" ? { ok: false, error: "refused" } : { ok: true, paneId: "w1:p1" }),
      kill: () => true,
      attach: () => ({ exited: Promise.resolve(0), kill: () => {} }),
    },
    clock: { now: (t => () => (t += 10))(0), sleep: async () => {} },
  });
  const io = { ...fs, existsSync: t => (String(t).endsWith("ready.json") ? true : fs.existsSync(t)) };
  const started = await instance.start({ io, withEnv: false, pluginDir: "C:/plugins/aify" });
  assert.equal(started.ok, true, "a plugin that would not link refused the whole launch");
  assert.equal(instance.pluginLinked, false);
  assert.match(instance.pluginError, /refused/);
});
