// hermes-aify's kill-prior ends the previous launch's delivery loop on every platform (lib/hermes-prior-runs.mjs).
//
// It was `pkill`/`pgrep` behind `command -v pkill`, and Git for Windows has neither, so on Windows a relaunched hermes
// agent kept its old loop running and read online. THE KILL IS FENCED in the one test that reads the real process
// table: it may end only the sleeper this test spawned, and any other pid it is asked to kill fails the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ancestors, descendants, parseCommandTable, processTable } from "../lib/process-identity.mjs";
import { priorHermesRuns, reapPriorHermesRuns } from "../lib/hermes-prior-runs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "wrappers", "hermes-aify.sh.in"), "utf8");

const row = (pid, ppid, startedAtMs, commandLine) => [pid, { pid, ppid, startedAtMs, commandLine }];
const LOOP = "C:\\Users\\a\\.aify-comms\\mcp\\stdio/hermes-managed-host.js run";

test("THE AGENT ID IS MATCHED WHOLE, the nohup parent stands for its child, and no TUI is taken", () => {
  const table = new Map([
    row(1, 0, 0, "init"),
    row(10, 1, 100, `"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node ${LOOP} pc`),
    row(11, 10, 110, `C:\\nvm4w\\nodejs\\node.exe ${LOOP} pc`),
    row(20, 1, 100, `node ${LOOP} pc-manager`),
    row(30, 1, 100, "hermes --tui --resume 20261013_old"),
    row(31, 1, 100, "hermes --tui --resume 20261013_older"),
  ]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", self: 1 }), [10]);
  // A TUI is the lease's to end with its launch; one nothing launched for the agent is left alone (operator's ruling).
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

test("THE NEW LOOP'S nohup STUB IS SPARED when the launcher excludes node, the pid Git Bash's $! names", () => {
  // Measured 2026-10-13: `nohup node … &` then `/proc/$!/winpid` gave node.exe, and nohup.exe stayed alive as its parent
  // with the loop's command line. Taking that stub orphans the new loop from the launcher's exit trap.
  const table = new Map([
    row(1, 0, 0, "init"),
    row(5, 1, 50, "bash hermes-aify --aify-agent pc"),
    row(10, 5, 100, `"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node ${LOOP} pc`), // this launch's stub
    row(11, 10, 110, `C:\\nvm4w\\nodejs\\node.exe ${LOOP} pc`), // this launch's loop: the excluded winpid
    row(20, 1, 60, `"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node ${LOOP} pc`), // the previous launch's stub
    row(21, 20, 70, `C:\\nvm4w\\nodejs\\node.exe ${LOOP} pc`),
  ]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", exclude: [11], self: 1 }), [20]);
});

test("WHAT A PROCESS RUNS IS MATCHED, NOT WHAT IT MENTIONS: an observer of the loop's text is not the loop", () => {
  // Review of 39d61c5: a process given the loop's text as an argument, and its child, were selected as kill targets.
  const table = new Map([
    row(1, 0, 0, "init"),
    row(40, 1, 100, `node observer.js "hermes-managed-host.js run pc"`),
    row(41, 40, 110, `node ${LOOP} pc-manager`),
    row(42, 1, 100, `grep -- "--tui --resume 20261013_old" log.txt`),
    row(43, 1, 100, `node --max-old-space-size=512 ${LOOP} pc`), // the loop, with a node option
    row(44, 1, 100, "node C:/tools/observer.js hermes --tui --resume 20261013_old"), // "hermes" as an argument
    row(45, 44, 110, "node child.js"),
  ]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", self: 1 }), [43]);
});

test("ANOTHER AGENT'S PROCESSES ARE NEVER TARGETS, and never inside a kill: its TUI, its host, the excluded loop", () => {
  // Review of 39d61c5: pc-manager's TUI resuming the same session was selected, and the kill itself received no
  // exclusions, so a tree or group walk reached the excluded loop and another agent's processes.
  const table = new Map([
    row(1, 0, 0, "init"),
    row(30, 1, 100, "hermes --tui --resume 20261013_shared"), // pc-manager's, named by its lease
    row(31, 1, 100, "hermes --tui --resume 20261013_shared"), // an operator's own window on this session: left alone
    row(10, 1, 100, `node ${LOOP} pc`), // the old loop, now hosting pc-manager's 40
    row(40, 10, 120, "hermes --tui"),
    row(20, 1, 300, `nohup node ${LOOP} pc`), // this launch's loop
    row(21, 20, 310, `node ${LOOP} pc`),
    row(50, 1, 100, `node ${LOOP} pc`), // a previous loop hosting nobody: the one target
  ]);
  const others = new Set([30, 40]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", exclude: [20], self: 1, others }), [50]);
  const kills = [];
  reapPriorHermesRuns({ agentId: "pc", exclude: [20], table, others,
    kill: (pid, options) => kills.push({ pid, spare: options.spare, boundaries: options.boundaries }) });
  assert.deepEqual(kills, [{ pid: 50, spare: [20, 21], boundaries: [30, 40] }]);
});

test("A LOOP WHOSE PARENT ID WAS REUSED IS STILL ITS OWN TARGET, not dropped as that newer process's child", () => {
  // Review of 39d61c5: loop 11 (born 100) names parent 10, now a newer matched loop (born 200). Ending 10's tree does
  // not reach 11, since 11 is older than 10, so dropping 11 as a duplicate left it running.
  const table = new Map([row(1, 0, 0, "init"), row(10, 1, 200, `node ${LOOP} pc`), row(11, 10, 100, `node ${LOOP} pc`)]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", self: 1 }), [10, 11]);
});

test("A COMMAND LINE WITH A LINE BREAK IS ONE ROW in the live table, never a forged second process", { skip: process.platform !== "win32" }, async () => {
  // Review of 39d61c5: a command line printed with its line break parsed as a second row, and that row was killed.
  const forged = 3_999_999_999;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", `x\n${forged}\t1\t2026-10-13T00:00:00.0000000Z\tnode ${LOOP} pc`],
    { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const table = processTable({ commands: true });
    assert.ok(table?.get(child.pid), "the live table lists the child");
    assert.equal(table.has(forged), false, "a line break inside a command line forged a process");
    assert.match(table.get(child.pid).commandLine, new RegExp(`${forged}`), "the flattened command line keeps its text");
  } finally {
    child.kill();
  }
});

test("AN UNTIMED ROW is never a target, never walked into, and stops an ancestry walk while naming its parent", () => {
  // A commands table lists processes it could not time (review of 3e27beb); nothing shows such a row is not a reused pid.
  const untimed = (pid, ppid, cmd) => [pid, { pid, ppid, startedAtMs: null, commandLine: cmd }];
  // 13's start is null, as the producers write it; 14 has none at all, which a null-safe comparison alone lets through.
  const table = new Map([row(1, 0, 0, "init"), untimed(10, 1, `node ${LOOP} pc`), row(11, 10, 200, "child"), row(12, 1, 100, "shell"), untimed(13, 12, "x"),
    [14, { pid: 14, ppid: 12, commandLine: "y" }]]);
  assert.deepEqual(priorHermesRuns(table, { agentId: "pc", self: 1 }), [], "an untimed delivery loop was chosen to be ended");
  assert.deepEqual(descendants(12, table), [], "an untimed child was walked into");
  assert.deepEqual([...ancestors(11, table)], [11, 10], "the walk went past an untimed parent, or did not name it");
});

test("AN UNREADABLE TABLE ENDS NOTHING", () => {
  const killed = [];
  assert.equal(reapPriorHermesRuns({ agentId: "pc", table: null, kill: (pid) => killed.push(pid) }), 0);
  assert.deepEqual(killed, []);
});

test("THE COMMAND TABLE PARSES Windows CIM lines and ps lstart lines", () => {
  const win = parseCommandTable("4\t0\t2026-10-13T00:00:00.0000000Z\tnode.exe\t1\tC:\\x\\node.exe a b\n", { platform: "win32" });
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

test("ONLY THE LEASE HOLDER REAPS: a launch whose claim failed starts, but ends nothing", async () => {
  // Whole-diff review of 0.9.2: a failed claim clears AIFY_LEASE_AGENT and returns 0 (bin/aify-lease.sh), and the reap
  // then ran anyway and could end the holder's live loop. Run the launcher's own function with the reap stubbed.
  const start = TEMPLATE.indexOf("aify_hermes_kill_prior() {");
  const fn = TEMPLATE.slice(start, TEMPLATE.indexOf("\n}\n", start) + 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-gate-"));
  const reap = path.join(dir, "bin");
  fs.mkdirSync(reap, { recursive: true });
  const marker = path.join(dir, "reaped").replace(/\\/g, "/");
  fs.writeFileSync(path.join(reap, "aify-hermes-reap-prior.mjs"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  const run = (lease) => spawnSync("bash", ["-c", `${fn}\naify_hermes_kill_prior pc 2`], {
    env: { ...process.env, AIFY_WRAPPER_DIR_FWD: dir.replace(/\\/g, "/"), AIFY_LEASE_AGENT: lease }, encoding: "utf8" });
  try {
    run("");
    assert.equal(fs.existsSync(marker), false, "a launch holding no lease reaped");
    run("pc-manager");
    assert.equal(fs.existsSync(marker), false, "a lease for another agent reaped this one");
    run("pc");
    assert.equal(fs.existsSync(marker), true, "CONTROL: the holder's reap ran");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A REAL LOOP LEFT RUNNING is found in the live table and ended; nothing else is", async () => {
  const agent = `fence-${process.pid}`;
  // A real script by the loop's name, run the way the launcher runs it: `node <dir>/hermes-managed-host.js run <agent>`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-reap-"));
  const script = path.join(dir, "hermes-managed-host.js");
  fs.writeFileSync(script, "setTimeout(() => {}, 120000);\n");
  const sleeper = spawn(process.execPath, [script, "run", agent], { stdio: "ignore" });
  const strays = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const table = processTable({ commands: true });
    assert.ok(table?.get(process.pid)?.commandLine, "the live table carries command lines");
    const ended = reapPriorHermesRuns({ agentId: agent, table, others: new Set(),
      kill: (pid) => (pid === sleeper.pid ? sleeper.kill() : strays.push(pid)) });
    assert.deepEqual(strays, [], "the reap tried to end processes this test did not start");
    assert.equal(ended, 1, "the sleeper was not found by its command line");
  } finally {
    try { sleeper.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
