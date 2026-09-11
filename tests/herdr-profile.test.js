#!/usr/bin/env node
// Isolation is the whole of `herdr-aify`, and it fails silently when it fails.
//
// THE FAILURE IT PREVENTS. A dedicated Herdr that shares the operator's profile writes into their
// real `session.json`, which is the file every ordinary pane is restored from. Nothing would report
// that; it would show up as the operator's own workspaces changing shape after running an unrelated
// command. So each variable below is asserted individually rather than as "an env was built".
//
// MEASURED, NOT ASSUMED: `session.json` is written under XDG_CONFIG_HOME (not the state root), both
// roots are honoured on Windows before the platform fallback, and children of a pane inherit them.
// The third is why `agentEnv` exists at all.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { agentEnv, dedicatedEnvArgv, herdrServerEnv, profilePaths } from "../lib/herdr-profile.mjs";

const INVOCATION = "8c7cf6c8-2b3f-4a9e-9d6e-1f2a3b4c5d6e";
const ROOT = path.join("C:", "Users", "Someone", ".aify", "herdr");

const paths = (platform = "win32") => profilePaths({ profileRoot: ROOT, invocation: INVOCATION, platform });

test("a profile is derived from the invocation and sits under it", () => {
  const p = paths();
  assert.ok(p.configHome.includes(INVOCATION), "config root does not belong to this invocation");
  assert.ok(p.stateHome.includes(INVOCATION), "state root does not belong to this invocation");
  assert.notEqual(p.configHome, p.stateHome);
  assert.ok(p.socketPath.includes(INVOCATION), "two invocations would share one socket");
});

test("the socket is a named pipe on Windows and a file elsewhere", () => {
  assert.ok(paths("win32").socketPath.startsWith("\\\\.\\pipe\\"));
  assert.ok(paths("linux").socketPath.endsWith(".sock"));
});

test("a bad invocation or a relative root is refused rather than defaulted", () => {
  // A configurable path here is a way to point a dedicated Herdr at the operator's real profile.
  assert.throws(() => profilePaths({ profileRoot: ROOT, invocation: "not-a-uuid" }), /uuid/);
  assert.throws(() => profilePaths({ profileRoot: "relative/path", invocation: INVOCATION }), /absolute/);
});

test("the server environment redirects BOTH roots, because the session file is under config", () => {
  const env = herdrServerEnv({ PATH: "/usr/bin" }, paths());
  assert.equal(env.XDG_CONFIG_HOME, paths().configHome);
  assert.equal(env.XDG_STATE_HOME, paths().stateHome);
  assert.equal(env.HERDR_SOCKET_PATH, paths().socketPath);
  assert.equal(env.PATH, "/usr/bin", "the rest of the environment must survive");
});

test("inherited Herdr wiring is cleared before the new wiring is set", () => {
  // THE REAL CASE: `herdr-aify` run from inside an ordinary Herdr pane. Leaving these would point
  // the dedicated instance's own CLI calls at the operator's Herdr.
  const inside = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p2",
    HERDR_TAB_ID: "w1:t2",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_BIN_PATH: "C:\\herdr.exe",
    HERDR_SOCKET_PATH: "C:/the/operators/herdr.sock",
  };
  const env = herdrServerEnv(inside, paths());
  for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_BIN_PATH"]) {
    assert.equal(env[name], undefined, `${name} was inherited into the dedicated instance`);
  }
  assert.equal(env.HERDR_SOCKET_PATH, paths().socketPath, "the dedicated socket must replace the inherited one");
  assert.notEqual(env.HERDR_SOCKET_PATH, inside.HERDR_SOCKET_PATH);
});

test("an agent started inside gets the isolation UNDONE, not passed on", () => {
  // Children of a pane inherit the XDG roots. An agent that kept them would write its profile into a
  // directory belonging to one invocation, and lose it when that invocation ends.
  const inPane = { ...herdrServerEnv({ PATH: "/usr/bin" }, paths()), HERDR_PANE_ID: "w3:p1", HERDR_ENV: "1" };
  const forAgent = agentEnv(inPane, { host: {} });
  assert.equal(forAgent.XDG_CONFIG_HOME, undefined);
  assert.equal(forAgent.XDG_STATE_HOME, undefined);
  assert.equal(forAgent.HERDR_PANE_ID, undefined);
  assert.equal(forAgent.PATH, "/usr/bin");
});

test("an agent gets back the host's own XDG values when the host had them", () => {
  // Removing them would be wrong on a machine that genuinely uses XDG: the honest undo is to restore
  // what the host had, and to remove only what the host did not set.
  const inPane = herdrServerEnv({}, paths());
  const forAgent = agentEnv(inPane, { host: { XDG_CONFIG_HOME: "/home/someone/.config" } });
  assert.equal(forAgent.XDG_CONFIG_HOME, "/home/someone/.config");
  assert.equal(forAgent.XDG_STATE_HOME, undefined, "a value the host never set must not be invented");
});

test("the daemon argv matches what aify-env's own reader accepts", () => {
  // Its reader refuses the flag unless args[0] starts with '-', and refuses a relative path.
  const argv = dedicatedEnvArgv("C:\\ctx\\instance.json");
  assert.deepEqual(argv, ["--instance-context", "C:\\ctx\\instance.json"]);
  assert.ok(argv[0].startsWith("-"), "aify-env refuses --instance-context unless it leads the argv");
  assert.throws(() => dedicatedEnvArgv("relative/instance.json"), /absolute/);
});
