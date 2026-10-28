#!/usr/bin/env node
// The hermes config change an install records is applied only into a host with no hermes running, once, before any
// queued start launches (lib/hermes-pending-config.mjs, bin/aify-hermes-pending-config.mjs, install.sh, hermes-aify).
//
// Nothing here reads the host's processes except the one CLI case, which says which branch this host took. Every
// marker, registry and hermes config is a temp one; the hermes is tests/fake-hermes.mjs.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FileLock, FileLockBusyError } from "../lib/file-lock.mjs";
import { hermesProcesses, OUTCOMES, PendingHermesConfig, pendingMarkerPath, runsHermes } from "../lib/hermes-pending-config.mjs";
import { processTable } from "../lib/process-identity.mjs";
import { launch } from "./launch-to-a-stub-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "aify-hermes-pending-config.mjs");
const CHECK = path.join(HERE, "..", "bin", "aify-wrapper-check.mjs");
const RACER = path.join(HERE, "hermes-pending-racer.mjs");
const FAKE = path.join(HERE, "fake-hermes.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-pending-"));

/**
 * Whether this host runs hermes, read by the test itself before and after `work`, so the branch a case expects is not
 * the one the code under test says it took. A host whose answer changes during the case cannot say which was right.
 */
function onThisHost(work) {
  const before = hermesProcesses(processTable({ commands: true })).length > 0;
  const result = work();
  const after = hermesProcesses(processTable({ commands: true })).length > 0;
  assert.equal(after, before, "hermes started or stopped on this host during the case; run it again");
  return { hermesRunning: before, result };
}
const table = (lines) => new Map(lines.map((commandLine, at) => [100 + at, { pid: 100 + at, commandLine }]));

// Every shape a running hermes showed on Windows (2026-10-28, user and ids replaced), and Linux's console script.
const VENV = "C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts";
const HERMES = [
  `${VENV}\\hermes.exe --tui --resume 20261004_080545_5ccbe2 --yolo`,
  `${VENV}\\hermes.exe dashboard --port 8792 --host 127.0.0.1 --no-open --skip-build`,
  `"${VENV}\\python.exe" "${VENV}\\hermes.exe" --tui --yolo`,
  `"C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\.hermes-runtime\\python\\generation-1\\cpython-3.11-windows-x86_64-none\\python.exe"  "${VENV}\\hermes.exe" dashboard --port 8754`,
  "/home/u/.hermes/hermes-agent/venv/bin/python3 /home/u/.local/bin/hermes --tui",
  "python3 -m hermes_cli.main chat",
];
// What runs beside hermes, or only names it, and is not hermes.
const NOT_HERMES = [
  '"C:\\Program Files\\Git\\usr\\bin\\bash.EXE" C:/Users/u/.local/bin/hermes-aify --aify-agent pc-manager --resume 20260907_192520_2d35dd',
  "C:\\nvm4w\\nodejs\\node.exe C:/Users/u/.aify-comms/mcp/stdio/hermes-managed-host.js run pc-manager",
  '"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node /c/Users/u/.aify-comms/mcp/stdio/hermes-managed-host.js run pc-manager',
  `C:\\Users\\u\\AppData\\Local\\hermes\\tools\\python-3.14.9\\python.exe -I -c "import runpy; runpy.run_path('${VENV}\\hermes.exe')"`,
  "C:\\Users\\u\\AppData\\Local\\hermes\\tools\\python-3.14.9\\python.exe C:\\Users\\u\\AppData\\Local\\Temp\\hermes_kernel_p94o02dg\\hermes_kernel_runner.py",
  "C:\\Users\\u\\AppData\\Local\\hermes\\tools\\node-26.12.1-win32-x64\\node.EXE --expose-gc C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\ui-tui\\dist\\entry.js",
  "node C:/w/bin/aify-hermes-pending-config.mjs apply --marker C:/h/.aify/hermes-config-pending.json",
  "code C:\\notes\\hermes.txt",
  "bash -c \"grep hermes /tmp/log\"",
];

test("a process runs hermes by what it runs: the program and its python layers, never a launcher, a loop, a tool or a mention", () => {
  for (const line of HERMES) assert.equal(runsHermes(line), true, line);
  for (const line of NOT_HERMES) assert.equal(runsHermes(line), false, line);
  assert.deepEqual(hermesProcesses(table([...NOT_HERMES, HERMES[0]])), [100 + NOT_HERMES.length]);
});

/** A marker in a temp home, with a recording scan and step. */
function world({ running = [], tableReadable = true, stepOk = true, during } = {}) {
  const dir = temp();
  const pending = new PendingHermesConfig({ marker: path.join(dir, ".aify", "hermes-config-pending.json") });
  const calls = { scans: 0, steps: [] };
  const scan = () => {
    calls.scans += 1;
    return tableReadable ? table([...NOT_HERMES, ...running]) : null;
  };
  const step = (registry) => {
    calls.steps.push(registry);
    during?.(pending);
    return stepOk ? { ok: true, detail: "" } : { ok: false, detail: "the hermes config step exited 78, its reason above" };
  };
  return { dir, pending, calls, apply: () => pending.apply({ scan, step }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("nothing pending: nothing is scanned or run", () => {
  const w = world();
  try {
    assert.deepEqual(w.apply(), { outcome: "none", detail: "nothing pending" });
    assert.deepEqual(w.calls, { scans: 0, steps: [] });
  } finally {
    w.cleanup();
  }
});

test("hermes running: the change waits, named, and the marker stays; a quiet host applies it once and removes the marker", () => {
  const busy = world({ running: [HERMES[1]] });
  try {
    busy.pending.record(path.join(busy.dir, "services.json"));
    const waited = busy.apply();
    assert.equal(waited.outcome, "deferred");
    assert.match(waited.detail, /hermes is running here \(pid \d+\)/);
    assert.deepEqual(busy.calls.steps, [], "the step ran while hermes was running");
    assert.equal(busy.pending.read().state, "pending");
  } finally {
    busy.cleanup();
  }
  const quiet = world();
  try {
    quiet.pending.record(path.join(quiet.dir, "services.json"));
    assert.equal(quiet.apply().outcome, "applied");
    assert.deepEqual(quiet.calls.steps, [path.join(quiet.dir, "services.json")]);
    assert.equal(quiet.pending.read().state, "none");
  } finally {
    quiet.cleanup();
  }
});

test("a host whose processes cannot be listed is not taken for a quiet one", () => {
  const w = world({ tableReadable: false });
  try {
    w.pending.record(path.join(w.dir, "services.json"));
    const result = w.apply();
    assert.equal(result.outcome, "deferred");
    assert.match(result.detail, /cannot be listed/);
    assert.deepEqual(w.calls.steps, []);
  } finally {
    w.cleanup();
  }
});

test("a step that fails leaves the change pending; a newer install's record made during the step is kept for the next start", () => {
  const failing = world({ stepOk: false });
  try {
    failing.pending.record(path.join(failing.dir, "services.json"));
    assert.equal(failing.apply().outcome, "failed");
    assert.equal(failing.pending.read().state, "pending");
  } finally {
    failing.cleanup();
  }
  const newer = world({ during: (pending) => pending.record(path.join(os.tmpdir(), "a-newer-registry.json")) });
  try {
    newer.pending.record(path.join(newer.dir, "services.json"));
    assert.equal(newer.apply().outcome, "applied");
    const left = newer.pending.read();
    assert.equal(left.state, "pending", "the newer record was removed with the one applied");
    assert.equal(left.registry, path.join(os.tmpdir(), "a-newer-registry.json"));
  } finally {
    newer.cleanup();
  }
});

test("the record names the registry and nothing else: no entry, so no key, is written to disk", () => {
  const w = world();
  try {
    w.pending.record("relative/services.json");
    const body = JSON.parse(fs.readFileSync(w.pending.marker, "utf8"));
    assert.deepEqual(Object.keys(body).sort(), ["recordedAt", "registry", "version"]);
    assert.equal(body.registry, path.resolve("relative/services.json"), "a relative registry is recorded as the path it means");
    fs.writeFileSync(w.pending.marker, "{ not json");
    assert.equal(w.apply().outcome, "failed", "a record that cannot be read is applied by nobody");
    assert.deepEqual(w.calls.steps, []);
  } finally {
    w.cleanup();
  }
});

test("a start whose wait behind a live holder runs out goes on without the change, rather than failing its launch", () => {
  const dir = temp();
  const marker = path.join(dir, ".aify", "hermes-config-pending.json");
  try {
    // This process holds the lock, and is alive for as long as the case runs.
    const held = new FileLock({ path: `${marker}.lock`, waitMs: 0, staleMs: 60_000 });
    held.hold(() => {
      assert.throws(() => new FileLock({ path: `${marker}.lock`, waitMs: 300, staleMs: 60_000 }).hold(() => {}), FileLockBusyError);
      // A short wait behind a holder that is not yet stale: in use the two are the same, so the holder's apply bounds both.
      const pending = new PendingHermesConfig({ marker, lockMs: 300, lock: { staleMs: 60_000 } });
      pending.record(path.join(dir, "services.json"));
      let stepped = false;
      const result = pending.apply({ scan: () => new Map(), step: () => { stepped = true; return { ok: true, detail: "" }; } });
      assert.equal(result.outcome, "deferred");
      assert.match(result.detail, /another start still holds/);
      assert.equal(stepped, false);
      assert.equal(pending.read().state, "pending");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RESTART ALL: starts arriving together apply the change once, and every one launches after it, not around it", async () => {
  const dir = temp();
  const marker = path.join(dir, ".aify", "hermes-config-pending.json");
  const log = path.join(dir, "race.log");
  fs.writeFileSync(log, "");
  try {
    new PendingHermesConfig({ marker }).record(path.join(dir, "services.json"));
    const starts = Array.from({ length: 4 }, () => spawn(process.execPath, [RACER, marker, log], { stdio: "ignore" }));
    await Promise.all(starts.map((child) => new Promise((resolve) => child.on("exit", resolve))));
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
    const end = lines.indexOf("end");
    assert.equal(lines.filter((word) => word === "begin").length, 1, lines.join(" "));
    assert.ok(lines.slice(0, end).filter((word) => word === "arrive").length >= 2, `control: the starts did not overlap: ${lines.join(" ")}`);
    assert.deepEqual(lines.filter((word) => word.startsWith("launch")).sort(), ["launch-applied", "launch-none", "launch-none", "launch-none"]);
    assert.ok(lines.findIndex((word) => word.startsWith("launch")) > end, `a start launched before the apply ended: ${lines.join(" ")}`);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("THE COMMAND on this host: it records, then applies through the installer's step or waits, saying which", () => {
  const dir = temp();
  // Where install.sh and hermes-aify put it ($HOME/.aify), which is where aify-wrapper-check looks by default.
  const marker = pendingMarkerPath(dir);
  assert.equal(marker, path.join(dir, ".aify", "hermes-config-pending.json"));
  const registry = path.join(dir, "services.json");
  const state = path.join(dir, "state.json");
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-dashboard": {
    endpoint: "http://127.0.0.2:9700", sessionInject: { mcp: true }, mcp: [{ name: "aify-dashboard", command: "node", args: ["/d/bridge.mjs"] }] } } }));
  fs.writeFileSync(state, "{}");
  fs.writeFileSync(calls, "");
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, HERMES_HOME: path.join(dir, "hermes"), LOCALAPPDATA: path.join(dir, "local"),
    HERMES_RUNTIME_COMMAND: FAKE, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: calls };
  try {
    assert.equal(spawnSync(process.execPath, [CLI, "record", "--marker", marker, "--registry", registry], { env }).status, 0);
    const { hermesRunning, result: applied } = onThisHost(() => spawnSync(process.execPath, [CLI, "apply", "--marker", marker], { env, encoding: "utf8", timeout: 120_000 }));
    const sets = fs.readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith('["config","set"'));
    if (!hermesRunning) {
      assert.equal(applied.status, OUTCOMES.applied, applied.stderr);
      assert.match(applied.stderr, /is applied/);
      assert.equal(sets.length, 1, "applied without the installer's step");
      assert.equal(fs.existsSync(marker), false);
    } else {
      // This host runs hermes, as the development host does while its agents are up.
      assert.equal(applied.status, OUTCOMES.deferred, applied.stderr);
      assert.match(applied.stderr, /hermes is running here/);
      assert.deepEqual(sets, [], "a config set reached hermes while hermes was running");
      assert.equal(fs.existsSync(marker), true);
    }
    // No --pending: the check finds the marker where the installer and the launcher put it.
    const shown = JSON.parse(spawnSync(process.execPath, [CHECK, "--dest", path.join(dir, "bin"), "--registry", registry, "--json"],
      { encoding: "utf8", env }).stdout);
    assert.equal(shown.hermesConfigPending === null, applied.status === 0, "aify-wrapper-check does not say what was left pending");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install.sh --client hermes records the change, and writes the hermes config only into a host with no hermes running", () => {
  const dir = temp();
  const posix = (p) => p.split(path.sep).join("/");
  const registry = path.join(dir, "services.json");
  const state = path.join(dir, "state.json");
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-dashboard": {
    endpoint: "http://127.0.0.2:9700", sessionInject: { mcp: true }, mcp: [{ name: "aify-dashboard", command: "node", args: ["/d/bridge.mjs"] }] } } }));
  fs.writeFileSync(state, "{}");
  fs.writeFileSync(calls, "");
  fs.mkdirSync(path.join(dir, "bridge"));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, HERMES_HOME: path.join(dir, "hermes"), LOCALAPPDATA: path.join(dir, "local"),
    HERMES_RUNTIME_COMMAND: FAKE, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: calls, AIFY_NO_PROMPT: "1" };
  try {
    const { hermesRunning, result: run } = onThisHost(() => spawnSync("bash", [path.join(HERE, "..", "install.sh"), "--client", "hermes",
      "--endpoint", "http://127.0.0.2:1", "--dest", posix(path.join(dir, "bin")), "--bridge-dir", posix(path.join(dir, "bridge")),
      "--registry", posix(registry)], { encoding: "utf8", timeout: 180_000, env }));
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, "bin", "hermes-aify")), "the launcher was not installed");
    const sets = fs.readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith('["config","set"'));
    const marker = path.join(dir, ".aify", "hermes-config-pending.json");
    if (hermesRunning) {
      assert.deepEqual(sets, [], "the install wrote the hermes config while hermes was running");
      assert.match(run.stderr, /hermes config change is pending/);
      assert.equal(new PendingHermesConfig({ marker }).read().registry, path.resolve(registry));
    } else {
      assert.equal(sets.length, 1, `a quiet host was not given the change: ${run.stderr}`);
      assert.equal(fs.existsSync(marker), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const definition = { version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "hermes",
  mode: "resident", workspace: "C:/work", model: "m-1", effort: "high", instructions: "", env: {}, herdrSpace: true } };
// The step stands in for bin/aify-hermes-pending-config.mjs: it says how it was called, and whether the runtime had
// started before it, on stderr, which the launcher passes through.
const STEP_STUB = [
  'import fs from "node:fs";',
  "process.stderr.write(`STEP ${JSON.stringify({ args: process.argv.slice(2), runtime: process.env.HERMES_RUNTIME_COMMAND ?? null,",
  "  runtimeFirst: fs.existsSync(process.env.STUB_RUNTIME_ENV) })}\\n`);",
  "process.exit(Number(process.env.STUB_STEP_EXIT));",
  "",
].join("\n");

test("hermes-aify runs the step before its hermes when a change is pending, with its own hermes command; it starts either way", () => {
  const files = { "wrapper/bin/aify-hermes-pending-config.mjs": STEP_STUB, "<home>/.aify/hermes-config-pending.json": "{}" };
  for (const [code, said] of [["0", null], ["75", null], ["78", /the pending hermes config step exited 78; this start goes on without it/]]) {
    const { run, started, home } = launch("hermes", ["--aify-agent", "lead", "chat"], { definitions: { lead: definition }, files, env: { STUB_STEP_EXIT: code } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(started.PATH, "the runtime did not start");
    const step = JSON.parse(/^STEP (.*)$/m.exec(run.stderr)?.[1] ?? "null");
    assert.ok(step, `the step did not run: ${run.stderr}`);
    assert.deepEqual(step.args.slice(0, 2), ["apply", "--marker"]);
    const at = (file) => path.resolve(file).toLowerCase();
    assert.equal(at(step.args[2]), at(path.join(home, ".aify", "hermes-config-pending.json")));
    assert.equal(step.runtime, "hermes", "the step was not handed the launcher's hermes command");
    assert.equal(step.runtimeFirst, false, "hermes started before the step");
    if (said) assert.match(run.stderr, said);
    else assert.doesNotMatch(run.stderr, /pending hermes config step exited/);
  }
  const quiet = launch("hermes", ["--aify-agent", "lead", "chat"], { definitions: { lead: definition }, files: { "wrapper/bin/aify-hermes-pending-config.mjs": STEP_STUB },
    env: { STUB_STEP_EXIT: "0" } });
  assert.equal(quiet.run.status, 0, quiet.run.stderr);
  assert.doesNotMatch(quiet.run.stderr, /^STEP /m, "the step ran with nothing pending");
});
