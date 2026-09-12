#!/usr/bin/env node
// A dedicated instance must not make the operator walk Herdr's first-launch flow every time.
//
// THE DEFECT THIS EXISTS FOR, in the operator's words after running the working command:
//
//   "i see first that herdr message (what herdr is, like first launch) then i press enter to
//    continue. then it throws me to integration settings ... so i press continue."
//
// Every invocation mints a FRESH profile -- that isolation is the feature -- so Herdr saw a brand new
// config root each time and ran onboarding each time. Two pages and two keypresses standing between
// the operator and the thing they asked for, on every single launch.
//
// THE FIX IS HERDR'S OWN SPELLING, not a guess: a real run was completed by hand and the entire state
// Herdr keeps for this turned out to be one line in `config.toml` — `onboarding = false`. That file
// was read off the invocation directory afterwards, which is why this is a measurement rather than a
// plausible-looking key.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { dedicatedHerdrConfig, profilePaths } from "../lib/herdr-profile.mjs";
import { HerdrAifyInstance } from "../lib/herdr-supervisor.mjs";

function paths() {
  return profilePaths({
    profileRoot: fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-onboard-")),
    invocation: randomUUID(),
    platform: "win32",
  });
}

test("the config goes where Herdr looks, inside the invocation's own config root", () => {
  const profile = paths();
  const config = dedicatedHerdrConfig(profile);
  assert.equal(config.file, path.join(profile.configHome, "herdr", "config.toml"));
  // It must be UNDER the isolated root: a path that escaped it would edit the operator's real Herdr.
  assert.ok(config.file.startsWith(profile.configHome + path.sep));
  assert.match(config.contents, /^onboarding = false\r?\n?$/);
});

test("THE WHOLE POINT: starting an instance leaves onboarding already answered", async () => {
  const profile = paths();
  const instance = new HerdrAifyInstance({
    profileRoot: path.dirname(path.dirname(profile.root)),
    invocation: path.basename(profile.root),
    platform: "win32",
    processes: {
      spawn: () => ({ pid: 1, failed: false, exited: false, started: Promise.resolve() }),
      run: (_c, argv) => (argv[0] === "workspace" ? { ok: true, paneId: "w1:p1" } : { ok: true }),
      kill: () => true,
      attach: () => ({ exited: Promise.resolve(0), kill: () => {} }),
    },
    clock: { now: (t => () => (t += 10))(0), sleep: async () => {} },
  });

  const io = { ...fs, existsSync: t => (String(t).endsWith("ready.json") ? true : fs.existsSync(t)) };
  assert.equal((await instance.start({ io })).ok, true);

  const written = dedicatedHerdrConfig(instance.profile);
  assert.equal(fs.readFileSync(written.file, "utf8").trim(), "onboarding = false",
    "the instance still starts Herdr with an unanswered first-launch flow");
});

test("an existing config is never overwritten, and an unwritable one never fails the launch", async () => {
  const profile = paths();
  const config = dedicatedHerdrConfig(profile);
  fs.mkdirSync(path.dirname(config.file), { recursive: true });
  fs.writeFileSync(config.file, "onboarding = false\n[theme]\nname = \"mine\"\n");

  const instance = new HerdrAifyInstance({
    profileRoot: path.dirname(path.dirname(profile.root)),
    invocation: path.basename(profile.root),
    platform: "win32",
    processes: {
      spawn: () => ({ pid: 1, failed: false, exited: false, started: Promise.resolve() }),
      run: (_c, argv) => (argv[0] === "workspace" ? { ok: true, paneId: "w1:p1" } : { ok: true }),
      kill: () => true,
      attach: () => ({ exited: Promise.resolve(0), kill: () => {} }),
    },
    clock: { now: (t => () => (t += 10))(0), sleep: async () => {} },
  });
  const io = { ...fs, existsSync: t => (String(t).endsWith("ready.json") ? true : fs.existsSync(t)) };

  // POSITIVE CONTROL on the failure path: a write that throws must not take the launch with it.
  const hostile = { ...io, writeFileSync: (file, ...rest) => {
    if (String(file).endsWith("config.toml")) throw new Error("EACCES");
    return fs.writeFileSync(file, ...rest);
  } };
  assert.equal((await instance.start({ io: hostile })).ok, true, "an unwritable config refused the launch");
  assert.match(fs.readFileSync(config.file, "utf8"), /name = "mine"/, "an existing config was overwritten");
});
