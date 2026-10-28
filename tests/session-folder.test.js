#!/usr/bin/env node
// lib/session-folder.mjs: the files a launch writes that can hold a key, in ~/.aify/sessions/<agent id>/, a folder that
// is its owner's alone. What a launch does with it (the 78, the killed launch) is tests/session-http.test.js; the
// custody judgement itself is held to comms' by tests/the-session-key-is-resolved-as-comms-resolves-it.test.js.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { folderCustodyProblem, folderCustodyProblemFor } from "../lib/credential-custody.mjs";
import {
  recordLauncher, sessionFolder, sessionFolderName, sessionsRoot, sweepEndedLaunches, writeSessionFile,
} from "../lib/session-folder.mjs";

const WIN = process.platform === "win32";
const freshHome = (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sessions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};
/** Grant everyone read on `dir`, as a careless hand or a tool would. */
const widen = (dir) => (WIN ? execFileSync("icacls", [dir, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "ignore", windowsHide: true }) : fs.chmodSync(dir, 0o755));

test("a launch's folder is its agent's id, or _pid-<launcher pid> for a launch nobody named, and nothing that could climb out", () => {
  assert.equal(sessionFolderName("wrapper-senior-dev", 7), "wrapper-senior-dev");
  assert.equal(sessionFolderName("", 4242), "_pid-4242");
  for (const bad of ["..", "../x", "a/b", "a\\b", ".hidden", "-flag", "x".repeat(129)]) assert.equal(sessionFolderName(bad, 7), null, bad);
  assert.equal(sessionFolderName("", 0), null, "an unnamed launch with no pid got a folder");
});

test("the sessions folder is made owner-only and reads back so; one widened afterwards refuses rather than being narrowed", async (t) => {
  // Bug this catches: a folder that inherits its parent's grants (as %TEMP%'s files did), or a check that quietly fixes
  // a widened folder and so hides that something widened it.
  const home = freshHome(t);
  const made = await sessionFolder({ agentId: "probe-agent", launcherPid: 1, home });
  assert.equal(made.ok, true, made.problem);
  assert.equal(made.dir, path.join(sessionsRoot(home), "probe-agent"));
  assert.equal(await folderCustodyProblemFor(sessionsRoot(home)), "", "the sessions folder was not left owner-only");
  widen(sessionsRoot(home));
  const second = await sessionFolder({ agentId: "other-agent", launcherPid: 1, home });
  assert.equal(second.ok, false);
  assert.match(second.problem, /readable by|grants access beyond/);
  assert.notEqual(await folderCustodyProblemFor(sessionsRoot(home)), "", "the widened folder was narrowed behind the operator's back");
});

test("a session file is written whole, replacing the last one, and leaves no temp name behind", async (t) => {
  const home = freshHome(t);
  const { dir } = await sessionFolder({ agentId: "probe-agent", launcherPid: 1, home });
  const first = await writeSessionFile(dir, "mcp.json", "one\n");
  assert.equal(await writeSessionFile(dir, "mcp.json", "two\n"), first);
  assert.equal(fs.readFileSync(first, "utf8"), "two\n");
  assert.deepEqual(fs.readdirSync(dir), ["mcp.json"]);
});

test("the folder judgement refuses a link, a file, and a folder granted to more than its owner", () => {
  const dir = (over = {}) => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700, ...over });
  assert.equal(folderCustodyProblem({ platform: "linux", stats: dir(), uid: 1000 }), "");
  assert.match(folderCustodyProblem({ platform: "linux", stats: dir({ mode: 0o40755 }), uid: 1000 }), /grants access beyond/);
  assert.match(folderCustodyProblem({ platform: "linux", stats: dir({ isSymbolicLink: () => true }), uid: 1000 }), /link/);
  assert.match(folderCustodyProblem({ platform: "linux", stats: dir({ isDirectory: () => false }), uid: 1000 }), /not a folder/);
  assert.match(folderCustodyProblem({ platform: "linux", stats: dir({ uid: 0 }), uid: 1000 }), /owned by uid 0/);
  const acl = (line) => `C:\\s ${line}\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  assert.equal(folderCustodyProblem({ platform: "win32", stats: dir(), owner: "HOST\\me", aclPath: "C:\\s", aclText: acl("HOST\\me:(OI)(CI)(F)") }), "");
  assert.match(folderCustodyProblem({ platform: "win32", stats: dir(), owner: "HOST\\me", aclPath: "C:\\s", aclText: acl("HOST\\CodexSandboxUsers:(I)(M)") }), /CodexSandboxUsers/);
});

test("the sweep removes an ended launch's folder and a reused pid's, and keeps a live one and any it cannot judge", async (t) => {
  // Bug this catches: an unnamed launch's key file kept forever after a kill, or a live launch's config deleted under it.
  const home = freshHome(t);
  const at = 1_790_000_000_000;
  const made = {};
  for (const pid of [11, 22, 33, 44, 55, 66]) {
    made[pid] = (await sessionFolder({ agentId: "", launcherPid: pid, home })).dir;
    await recordLauncher(made[pid], pid, at);
  }
  fs.writeFileSync(path.join(made[55], "launcher.json"), "not json");
  const alive = (pid) => pid !== 11; // 11 is gone
  // 22's pid now names a later process (reused); 44 cannot be probed; 66 is the same launch, still running.
  const startedAt = (pid) => (pid === 44 ? null : new Map([[pid, pid === 22 ? at + 60_000 : at - 60_000]]));
  const removed = await sweepEndedLaunches({ home, keep: "_pid-33", alive, startedAt, offsetMs: () => 0 });
  assert.deepEqual(removed.sort(), ["_pid-11", "_pid-22"]);
  assert.deepEqual(fs.readdirSync(sessionsRoot(home)).sort(), ["_pid-33", "_pid-44", "_pid-55", "_pid-66"]);
});
