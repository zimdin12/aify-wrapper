// hermes-aify's kill-prior ends the previous launch's delivery loop on every platform (lib/hermes-prior-runs.mjs).
//
// It was `pkill`/`pgrep` behind `command -v pkill`, and Git for Windows has neither, so on Windows a relaunched hermes
// agent kept its old loop running and read online. THE KILL IS FENCED in the one test that reads the real process
// table: it may end only the sleeper this test spawned, and any other pid it is asked to kill fails the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseCommandTable, processTable } from "../lib/process-identity.mjs";
import { priorHermesRuns, reapPriorHermesRuns } from "../lib/hermes-prior-runs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "wrappers", "hermes-aify.sh.in"), "utf8");

const row = (pid, ppid, startedAtMs, commandLine) => [pid, { pid, ppid, startedAtMs, commandLine }];
const LOOP = "C:\\Users\\a\\.aify-comms\\mcp\\stdio/hermes-managed-host.js run";

test("THE AGENT ID IS MATCHED WHOLE, the nohup parent stands for its child, and nothing else is taken", () => {
  const table = new Map([
    row(1, 0, 0, "init"),
    row(10, 1, 100, `"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node ${LOOP} pc`),
    row(11, 10, 110, `C:\\nvm4w\\nodejs\\node.exe ${LOOP} pc`),
    row(20, 1, 100, `node ${LOOP} pc-manager`),
    row(30, 1, 100, "hermes --tui --resume 20261013_old"),
    row(31, 1, 100, "hermes --tui --resume 20261013_older"),
  ]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", self: 1 }), [10]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", resumeId: "20261013_old", self: 1 }), [10, 30]);
});

test("THIS LAUNCH'S OWN LOOP, everything it started, and the launcher's own ancestry are never taken", () => {
  const table = new Map([
    row(1, 0, 0, "init"),
    row(5, 1, 50, `bash hermes-aify ${LOOP} pc`), // an ancestor that merely names it
    row(6, 5, 60, "node aify-hermes-reap-prior.mjs --agent pc"),
    row(10, 5, 100, `nohup node ${LOOP} pc`), // the loop just started, excluded by pid
    row(11, 10, 110, `node ${LOOP} pc`), // its child
    row(40, 1, 90, `node ${LOOP} pc`), // the previous launch's loop
  ]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", exclude: [10], self: 6 }), [40]);
});

test("AN UNREADABLE TABLE ENDS NOTHING", () => {
  const killed = [];
  assert.equal(reapPriorHermesRuns({ agentId: "pc", table: null, kill: (pid) => killed.push(pid) }), 0);
  assert.deepEqual(killed, []);
});

test("THE COMMAND TABLE PARSES Windows CIM lines and ps lstart lines", () => {
  const win = parseCommandTable("4\t0\t2026-10-13T00:00:00.0000000Z\tC:\\x\\node.exe a b\n", { platform: "win32" });
  assert.equal(win.get(4).commandLine, "C:\\x\\node.exe a b");
  const ps = parseCommandTable("  7     1 Mon Oct 13 01:02:03 2026 node /x/hermes-managed-host.js run pc\n", { platform: "linux" });
  assert.equal(ps.get(7).commandLine, "node /x/hermes-managed-host.js run pc");
});

test("THE LAUNCHER CALLS THE NODE REAP with no pkill gate, its own loop excluded by Windows pid", () => {
  const start = TEMPLATE.indexOf("aify_hermes_kill_prior() {");
  const body = TEMPLATE.slice(start, TEMPLATE.indexOf("\n}\n", start));
  const code = body.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /command -v pkill|pgrep|pkill /, "a pkill gate skips the whole reap on Git for Windows");
  assert.match(body, /aify-hermes-reap-prior\.mjs" --agent "\$agent_id"/);
  assert.match(body, /\/proc\/\$exclude_pid\/winpid/, "Git Bash's \$! is not the Windows pid the table lists");
});

test("A REAL LOOP LEFT RUNNING is found in the live table and ended; nothing else is", async () => {
  const agent = `fence-${process.pid}`;
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", "hermes-managed-host.js", "run", agent],
    { stdio: "ignore" });
  const strays = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const table = processTable({ commands: true });
    assert.ok(table?.get(process.pid)?.commandLine, "the live table carries command lines");
    const ended = reapPriorHermesRuns({ agentId: agent, table, kill: (pid) => (pid === sleeper.pid ? sleeper.kill() : strays.push(pid)) });
    assert.deepEqual(strays, [], "the reap tried to end processes this test did not start");
    assert.equal(ended, 1, "the sleeper was not found by its command line");
  } finally {
    try { sleeper.kill(); } catch { /* already gone */ }
  }
});
