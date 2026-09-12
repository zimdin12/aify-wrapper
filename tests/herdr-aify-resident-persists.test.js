#!/usr/bin/env node
// Plain `herdr-aify` is the Herdr this host KEEPS, and leaving it detaches.
//
// THE DEFECT THIS EXISTS FOR, in the operator's words after using it:
//
//   "i started resident claude-aify llamacpp-manager with command. then i detached and i still see
//    llamacpp running in dashboard (online). then i started it again (herdr-aify) and i do not see
//    that llamacpp space nor agent, but aify-comms dashboard shows that he is online (still is, so
//    orphan resident???)"
//
// and the rule they gave: "ordinary herdr-aify should remember previous instance agents like
// ordinary herdr does, that herdr-aify env is the one that really acts differently."
//
// Plain mode minted a FRESH INVOCATION PROFILE per launch, so Herdr had no session to restore and
// every launch was a first launch. The agent was left running with nothing pointing at it, which is
// the orphan: aify-comms could still see it, and Herdr could not.
//
// THE FIX IS A STABLE PROFILE plus start-or-attach. What these tests pin is the DECISION: one
// profile for every plain launch, a server started only when nothing answers, and the invocation
// machinery kept out of it -- that machinery exists so a dedicated instance cannot adopt an old
// one's workers, and here adopting the previous session IS the feature.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { profilePaths, residentPaths } from "../lib/herdr-profile.mjs";
import { ensureResident, residentIsServing, serverEnvFor } from "../lib/herdr-resident.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-resident-"));

test("THE DEFECT: every plain launch uses ONE profile, so there is a session to come back to", () => {
  const profileRoot = root();
  const first = residentPaths({ profileRoot });
  const second = residentPaths({ profileRoot });
  assert.deepEqual({ ...first }, { ...second }, "two launches got two profiles, so neither restores the other");

  // AND IT IS NOT THE INVOCATION PROFILE, which is per-launch by design. Sharing one would break the
  // other mode's guarantee that a new instance never adopts an old one's workers.
  const invocation = profilePaths({ profileRoot, invocation: randomUUID() });
  assert.notEqual(first.root, invocation.root);
  assert.notEqual(first.socketPath, invocation.socketPath);
  // NOR the operator's ordinary Herdr: its own XDG roots and its own socket.
  assert.ok(first.configHome.startsWith(first.root) && first.stateHome.startsWith(first.root));
});

test("a server is started ONLY when nothing answers, so a second launch attaches", async () => {
  const paths = residentPaths({ profileRoot: root() });
  const spawns = [];
  const answering = { ok: true };
  const attached = await ensureResident({
    paths, env: {}, bin: "herdr", io: fs, sleep: async () => {},
    cli: () => answering,
    spawn: (...args) => { spawns.push(args); return { failed: false, exited: false }; },
  });
  assert.deepEqual(attached, { ok: true, started: false, attached: true });
  assert.deepEqual(spawns, [], "it started a second server onto a profile that already had one");
});

test("POSITIVE CONTROL: with nothing answering it starts one, then waits for it", async () => {
  const paths = residentPaths({ profileRoot: root() });
  let answers = 0;
  const spawns = [];
  const started = await ensureResident({
    paths, env: {}, bin: "herdr", io: fs, sleep: async () => {},
    // Dead for the first three probes, then serving -- so the wait is exercised rather than skipped.
    cli: () => ({ ok: ++answers > 4 }),
    spawn: (...args) => { spawns.push(args); return { failed: false, exited: false }; },
  });
  assert.deepEqual(started, { ok: true, started: true, attached: false });
  assert.equal(spawns.length, 1, "no server was started for an empty profile");
  assert.deepEqual(spawns[0][1], ["server"]);
  assert.equal(spawns[0][2].env.HERDR_SOCKET_PATH, paths.socketPath, "the server was put on the wrong socket");
});

test("a server that dies is reported as dead, not waited out", async () => {
  // The dedicated instance had exactly this defect: a server that exited was reported twenty seconds
  // later as a readiness timeout, which says nothing true about what happened.
  const paths = residentPaths({ profileRoot: root() });
  const result = await ensureResident({
    paths, env: {}, bin: "herdr", io: fs, sleep: async () => {},
    cli: () => ({ ok: false }),
    spawn: () => ({ failed: false, exited: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited before it was ready/);
});

test("a server that cannot be spawned at all says so", async () => {
  const paths = residentPaths({ profileRoot: root() });
  const result = await ensureResident({
    paths, env: {}, bin: "herdr", io: fs, sleep: async () => {},
    cli: () => ({ ok: false }),
    spawn: () => ({ failed: true, error: "spawn herdr ENOENT" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

test("the environment points a client at THIS profile and nothing else", () => {
  const paths = residentPaths({ profileRoot: root() });
  const env = serverEnvFor({ PATH: "/usr/bin", HERDR_SOCKET_PATH: "somebody-elses.sock" }, paths);
  assert.equal(env.HERDR_SOCKET_PATH, paths.socketPath, "an inherited socket would drive the operator's own Herdr");
  assert.equal(env.XDG_CONFIG_HOME, paths.configHome);
  assert.equal(env.XDG_STATE_HOME, paths.stateHome);
  assert.equal(env.PATH, "/usr/bin", "it dropped the rest of the environment");
});

test("serving is decided by asking the socket, not by a file on disk", () => {
  const paths = residentPaths({ profileRoot: root() });
  assert.equal(residentIsServing({ paths, env: {}, bin: "herdr", cli: () => ({ ok: true }) }), true);
  assert.equal(residentIsServing({ paths, env: {}, bin: "herdr", cli: () => ({ ok: false }) }), false);
});

test("THE CALL SITE: a plain run goes to the resident and mints NO invocation", async () => {
  // The two modes differ in exactly this, and it is the half a helper test cannot see. A plain run
  // that minted an invocation would also write an owner pointer and refuse the NEXT plain run --
  // turning "come back to my session" into "an instance is already running here".
  const { run } = await import("../bin/herdr-aify.mjs");
  const profileRoot = root();
  const seen = [];
  const code = await run({
    profileRoot,
    env: {},
    attaching: false,
    withEnv: false,
    resident: async args => { seen.push(args); return 0; },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1, "a plain run did not go to the resident herdr");
  assert.equal(seen[0].profileRoot, profileRoot);
  assert.equal(fs.existsSync(path.join(profileRoot, "invocations")), false, "a plain run minted an invocation");
  assert.equal(fs.existsSync(path.join(profileRoot, "owner.json")), false, "a plain run claimed the owner pointer");
});

test("the resident server is started INDEPENDENT, because the launcher is supposed to leave", async () => {
  // MEASURED ON WINDOWS, and it made the launcher's own parting line false. `herdr-aify` prints
  // "detached; the herdr and its agents are still running" and returns; `main` sets `exitCode`
  // rather than calling `exit`, so node leaves when the event loop drains -- and a ref'd child
  // handle never lets it drain. The launcher sat there after the TUI was closed, holding the
  // operator's console, and closing that console took the server (and every agent in it) with it.
  const paths = residentPaths({ profileRoot: root() });
  const asked = [];
  await ensureResident({
    paths, env: {}, bin: "herdr", io: fs, sleep: async () => {},
    cli: () => ({ ok: false }),
    spawn: (bin, argv, options) => { asked.push(options); return { failed: true, error: "sealed" }; },
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].independent, true, "the resident server was started as a child that dies with the command");
});

test("INDEPENDENT really means the launcher can leave -- driven both ways", async () => {
  // THE OPTION REACHING `spawn` IS NOT THE GUARANTEE. `unref` is what releases the event loop, and
  // nothing above would notice its absence, so this runs the real `processes.spawn` in a real node
  // and measures the only thing that matters: does the parent exit while the child is still alive.
  const fixture = path.join(root(), "leave.mjs");
  const write = independent => fs.writeFileSync(fixture, [
    `import { processes } from ${JSON.stringify(pathToFileURL(path.resolve("bin/herdr-aify.mjs")).href)};`,
    `processes.spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { env: process.env, independent: ${independent} });`,
  ].join(String.fromCharCode(10)));

  const exits = async () => {
    const started = Date.now();
    const child = spawn(process.execPath, [fixture], { stdio: "ignore" });
    const left = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 6000);
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    return { left, ms: Date.now() - started };
  };

  write(true);
  const independent = await exits();
  assert.equal(independent.left, true, `the launcher could not leave: still running after ${independent.ms}ms`);

  // NEGATIVE CONTROL, driven by REMOVING the thing under test: an ordinary child holds the parent.
  // Without this the test above passes on a node that exits for some unrelated reason.
  write(false);
  const held = await exits();
  assert.equal(held.left, false, "an ordinary child did not hold the launcher, so this proves nothing");
});

test("the resident environment is the ISOLATED one, not three variables", () => {
  // TWO LEAKS, both invisible on a host that runs no other Herdr. Built by hand, this environment
  // carried the launching pane's ids into the resident and every agent in it, and left the ledger
  // pointing at `~/.aify/herdr/panes.json` -- which the operator's ordinary Herdr also uses, and
  // where a restore PRUNES every record whose pane it cannot see.
  const paths = residentPaths({ profileRoot: root() });
  const env = serverEnvFor({ PATH: "/usr/bin", HERDR_PANE_ID: "p7", HERDR_TAB_ID: "t2", HERDR_WORKSPACE_ID: "w9", HERDR_ENV: "1" }, paths);
  for (const leaked of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) {
    assert.equal(leaked in env, false, `${leaked} reached the resident, so its panes belong to somebody else's Herdr`);
  }
  assert.equal(env.AIFY_HERDR_LEDGER, path.join(paths.root, "panes.json"), "the resident shares the host Herdr's pane ledger");
});

test("A BINARY THAT CANNOT BE SPAWNED IS REPORTED, not left to crash the launcher", async () => {
  // Found by review. Node reports a spawn failure on a LATER tick by rejecting `started`; this code
  // sampled `failed` synchronously, never observed the promise, and an unhandled rejection ended the
  // launcher. Driven with the REAL adapter against a path that does not exist, so nothing starts --
  // a double that set `failed` immediately is exactly how the shipped test missed it.
  const { processes } = await import("../bin/herdr-aify.mjs");
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(String(reason?.message || reason));
  process.on("unhandledRejection", onUnhandled);
  try {
    const paths = residentPaths({ profileRoot: root() });
    const missing = path.join(root(), "no-such-herdr.exe");
    const result = await ensureResident({
      paths, env: {}, bin: missing, io: fs, sleep: async () => {}, attempts: 2,
      cli: () => ({ ok: false, code: "server_not_running" }),
      spawn: (command, argv, options) => processes.spawn(command, argv, options),
    });
    // Let any stray rejection surface before judging.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/, "the missing binary was not named as the reason");
    assert.deepEqual(unhandled, [], "the spawn failure escaped as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("SEALED: no test here may start a real Herdr", async () => {
  // This file's own guard. Every path above injects `cli` and `spawn`; the moment one does not, a
  // real `herdr server` is started and left running -- which happened, three times, in one suite run.
  const paths = residentPaths({ profileRoot: root() });
  let spawned = 0;
  await ensureResident({
    paths, env: {}, bin: "herdr-that-does-not-exist", io: fs, sleep: async () => {},
    cli: () => ({ ok: false }), spawn: () => { spawned += 1; return { failed: true, error: "sealed" }; },
  });
  assert.equal(spawned, 1, "the spawn was not the injected one");
});
