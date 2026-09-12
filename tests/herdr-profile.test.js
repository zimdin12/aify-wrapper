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
// The third is why the wrapper has to UNDO them, and why the markers below exist.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { HOST_XDG_MARKERS, ISOLATED_MARKER, dedicatedEnvArgv, herdrServerEnv, profilePaths } from "../lib/herdr-profile.mjs";

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

test("the socket is a FILE path on every platform, including Windows", () => {
  // MEASURED, after the first real run failed. A `\.\pipe\...` named pipe -- written by analogy
  // with the instance layout beside this -- made herdr exit 1 with PermissionDenied, and the
  // launcher could only report "exited before it was ready". Herdr uses a filesystem socket on
  // Windows too; a file path under the invocation root was measured starting cleanly.
  for (const platform of ["win32", "linux", "darwin"]) {
    const socket = paths(platform).socketPath;
    assert.ok(socket.endsWith(".sock"), `${platform} socket is not a file path: ${socket}`);
    assert.ok(!socket.includes("pipe"), `${platform} socket went back to a named pipe: ${socket}`);
    assert.ok(socket.includes(INVOCATION), "two invocations would share one socket");
  }
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

test("the server environment carries the UNDO the wrapper needs for agents inside it", () => {
  // THE DEFECT THIS REPLACES. There was a function here that built an agent's environment and it had
  // ZERO callers, while HERDR.md stated the mitigation as done. The thing that starts an agent is
  // the operator typing `claude-aify` into a pane -- a shell script -- so the undo cannot be a
  // function here; it has to be data the wrapper can read, which is what these markers are.
  const host = { PATH: "/usr/bin", XDG_CONFIG_HOME: "/home/someone/.config" };
  const env = herdrServerEnv(host, paths());
  assert.equal(env[ISOLATED_MARKER], "1", "a wrapper cannot tell it is inside a dedicated instance");
  assert.equal(env[HOST_XDG_MARKERS.XDG_CONFIG_HOME], "/home/someone/.config");
  // ABSENT MEANS ABSENT: a host that never set XDG_STATE_HOME must leave the agent without one,
  // rather than handing it an empty string that reads as "set".
  assert.equal(Object.prototype.hasOwnProperty.call(env, HOST_XDG_MARKERS.XDG_STATE_HOME), false);
  // And the isolation itself is still applied, or there would be nothing to undo.
  assert.equal(env.XDG_CONFIG_HOME, paths().configHome);
});

test("a dedicated instance gets its OWN pane ledger", () => {
  // Two Herdr servers sharing ~/.aify/herdr/panes.json means whichever restores first prunes away
  // every record belonging to the other, because a prune keys on the labels IT can see.
  const env = herdrServerEnv({}, paths());
  assert.ok(env.AIFY_HERDR_LEDGER.includes(INVOCATION), "the ledger is not scoped to this invocation");
  assert.ok(env.AIFY_HERDR_LEDGER.endsWith("panes.json"));
});

test("the daemon argv matches what aify-env's own reader accepts", () => {
  // Its reader refuses the flag unless args[0] starts with '-', and refuses a relative path.
  const argv = dedicatedEnvArgv("C:\\ctx\\instance.json");
  assert.deepEqual(argv, ["--instance-context", "C:\\ctx\\instance.json"]);
  assert.ok(argv[0].startsWith("-"), "aify-env refuses --instance-context unless it leads the argv");
  assert.throws(() => dedicatedEnvArgv("relative/instance.json"), /absolute/);
});
