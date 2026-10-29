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
import { hermesConfigTarget, hermesProcesses, lockBudget, OUTCOMES, PendingHermesConfig, pendingMarkerPath, runsHermes, sameTarget } from "../lib/hermes-pending-config.mjs";
import { imageName, linuxCommand, windowsArgv } from "../lib/process-argv.mjs";
import { parseCommandTable, processTable } from "../lib/process-identity.mjs";
import { launch } from "./launch-to-a-stub-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "aify-hermes-pending-config.mjs");
const CHECK = path.join(HERE, "..", "bin", "aify-wrapper-check.mjs");
const RACER = path.join(HERE, "hermes-pending-racer.mjs");
const RECORDER = path.join(HERE, "hermes-pending-recorder.mjs");
const WAITER = path.join(HERE, "hermes-pending-waiter.mjs");
const FAKE = path.join(HERE, "fake-hermes.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-pending-"));

/**
 * The processes that ran, or may have run, hermes for the whole of `work`: the same pid and start in a scan the test
 * makes before it and one after, so the code under test saw each of them. A case takes its branch from what the command
 * says it did and must defer when any is here. Only these bind it: the suite's own python probes and stub hermes come
 * and go between the scans, and one a scan catches may be gone by the command's (seen in the Linux run of 2026-10-28).
 */
function onThisHost(work) {
  const seen = () => {
    const table = processTable({ commands: true });
    const { running, unknown } = hermesProcesses(table);
    return [...running, ...unknown].filter((pid) => Number.isFinite(table.get(pid).startedAtMs)).map((pid) => `${pid}@${table.get(pid).startedAtMs}`);
  };
  const before = seen();
  const result = work();
  const after = new Set(seen());
  return { throughout: before.filter((process) => after.has(process)), result };
}
// What a command says when it leaves the change pending because of this host's processes.
const HOST_DEFERRAL = /hermes is running here|may be hermes|cannot be listed/;
/** A row as the Windows table gives it: the image CIM names, the command line parsed as Windows parses it. */
const win = (commandLine) => ({ image: imageName(windowsArgv(commandLine)[0]), argv: windowsArgv(commandLine), commandLine });
/** A row as the Linux table gives it: stat's comm, cmdline's NUL-separated words. */
const lin = (argv, image = imageName(argv[0])) => ({ image, argv, commandLine: argv.join(" ") });
const table = (rows) => new Map(rows.map((row, at) => [100 + at, { pid: 100 + at, ...row }]));
// The config every pending case below is recorded for and started with, unless it says otherwise.
const TARGET = path.join(os.tmpdir(), "hermes-home-a", "config.yaml");

// Every shape a running hermes showed on Windows (2026-10-28, user and ids replaced), and Linux's console script.
const VENV = "C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts";
const HERMES = [
  win(`${VENV}\\hermes.exe --tui --resume 20261004_080545_5ccbe2 --yolo`),
  win(`${VENV}\\hermes.exe dashboard --port 8792 --host 127.0.0.1 --no-open --skip-build`),
  win(`"${VENV}\\python.exe" "${VENV}\\hermes.exe" --tui --yolo`),
  win(`"C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\.hermes-runtime\\python\\generation-1\\cpython-3.11-windows-x86_64-none\\python.exe"  "${VENV}\\hermes.exe" dashboard --port 8754`),
  win(`C:\\Users\\u\\AppData\\Local\\hermes\\tools\\python-3.14.9\\python.exe -I -c "import runpy; runpy.run_path('${VENV}\\hermes.exe')"`),
  lin(["/home/u/.hermes/hermes-agent/venv/bin/python3", "/home/u/.local/bin/hermes", "--tui"]),
  lin(["python3", "-m", "hermes_cli.main", "chat"]),
  // The review of ba87799's shapes: a path with a space, and python options that take a value.
  lin(["/home/u/Agent Runtime/venv/bin/python3", "/home/u/.local/bin/hermes", "--tui"], "python3"),
  lin(["/home/u/runtime/venv/bin/python3", "-X", "utf8", "/home/u/.local/bin/hermes", "--tui"]),
  lin(["/home/u/runtime/venv/bin/python3", "-W", "ignore", "/home/u/.local/bin/hermes", "--tui"]),
  lin(["/home/u/runtime/venv/bin/python3", "-Xutf8", "-IB", "/home/u/.local/bin/hermes"]),
  win(`"C:\\Program Files\\Hermes Agent\\hermes.exe" --tui`),
  { image: "hermes", argv: null, commandLine: null },
];
// What runs beside hermes, or only names it, and is not hermes; and another program whose command line is unreadable.
const NOT_HERMES = [
  win('"C:\\Program Files\\Git\\usr\\bin\\bash.EXE" C:/Users/u/.local/bin/hermes-aify --aify-agent pc-manager --resume 20260907_192520_2d35dd'),
  win("C:\\nvm4w\\nodejs\\node.exe C:/Users/u/.aify-comms/mcp/stdio/hermes-managed-host.js run pc-manager"),
  win('"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node /c/Users/u/.aify-comms/mcp/stdio/hermes-managed-host.js run pc-manager'),
  win("C:\\Users\\u\\AppData\\Local\\hermes\\tools\\python-3.14.9\\python.exe C:\\Users\\u\\AppData\\Local\\Temp\\hermes_kernel_p94o02dg\\hermes_kernel_runner.py"),
  win("C:\\Users\\u\\AppData\\Local\\hermes\\tools\\node-26.12.1-win32-x64\\node.EXE --expose-gc C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent\\ui-tui\\dist\\entry.js"),
  win("node C:/w/bin/aify-hermes-pending-config.mjs apply --marker C:/h/.aify/hermes-config-pending.json"),
  win("code C:\\notes\\hermes.txt"),
  win('bash -c "grep hermes /tmp/log"'),
  lin(["python3", "-W", "ignore", "/srv/hermes-notes/report.py"]),
  { image: "svchost", argv: null, commandLine: null },
];
// What cannot be told: a python, or a process with no image, whose command line could not be read.
const UNKNOWN = [{ image: "python3", argv: null, commandLine: null }, { image: null, argv: null, commandLine: null }];

test("a process runs hermes by what it runs, with its argv as a list; one it cannot read is unknown unless its image rules it out", () => {
  for (const row of HERMES) assert.equal(runsHermes(row), "yes", JSON.stringify(row));
  for (const row of NOT_HERMES) assert.equal(runsHermes(row), "no", JSON.stringify(row));
  for (const row of UNKNOWN) assert.equal(runsHermes(row), "unknown", JSON.stringify(row));
  assert.deepEqual(hermesProcesses(table([...NOT_HERMES, HERMES[0], UNKNOWN[0]])), { running: [100 + NOT_HERMES.length], unknown: [101 + NOT_HERMES.length] });
});

test("the Windows table keeps a command line's boundaries and says when it could not read one", () => {
  assert.deepEqual(windowsArgv('"C:\\Program Files\\x\\python.exe" -X utf8 "C:\\a b\\hermes" "say \\"hi\\"" C:\\x\\\\'),
    ["C:\\Program Files\\x\\python.exe", "-X", "utf8", "C:\\a b\\hermes", 'say "hi"', "C:\\x\\\\"]);
  const rows = parseCommandTable(["4\t0\t2026-10-13T00:00:00.0000000Z\tHermes.EXE\t1\t\"C:\\Program Files\\h\\hermes.exe\" --tui",
    "5\t0\t2026-10-13T00:00:00.0000000Z\tpython.exe\t0\t"].join("\n"), { platform: "win32" });
  assert.deepEqual([rows.get(4).image, rows.get(4).argv], ["hermes", ["C:\\Program Files\\h\\hermes.exe", "--tui"]]);
  assert.deepEqual([rows.get(5).image, rows.get(5).argv, rows.get(5).commandLine], ["python", null, null], "an unreadable command line read as an empty one");
});

test("the Linux table keeps a process whose cmdline it cannot read, with no argv, instead of dropping it", () => {
  const stat = (pid, comm) => `${pid} (${comm}) S 1 ${pid} ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1000`;
  const files = { "/proc/stat": "btime 1700000000\n", "/proc/101/stat": stat(101, "python3"), "/proc/102/stat": stat(102, "node"), "/proc/102/cmdline": "node\0fixture.mjs\0" };
  const readFile = (file) => {
    if (file === "/proc/101/cmdline") throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (file in files) return files[file];
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  const rows = processTable({ platform: "linux", commands: true, bootEpoch: () => 1700000000, readDir: () => ["101", "102"], readFile });
  assert.deepEqual([rows.get(101)?.image, rows.get(101)?.argv], ["python3", null], "the unreadable row is missing or read as empty");
  assert.deepEqual(rows.get(102).argv, ["node", "fixture.mjs"]);
  assert.equal(hermesProcesses(rows).unknown[0], 101);
  assert.throws(() => linuxCommand(9, stat(9, "node"), readFile), { code: "ENOENT" }, "a process that ended before its cmdline was read is kept");
});

test("the command table lists a process it cannot time, so the gate sees it: a Linux stat it cannot read, a Windows process with no start", () => {
  // Review of 3e27beb: both rows were dropped, and with another row readable the table read quiet.
  const stat = (pid, comm) => `${pid} (${comm}) S 1 ${pid} ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1000`;
  const linux = (statError) => processTable({ platform: "linux", commands: true, bootEpoch: () => 1700000000, readDir: () => ["101", "102"], readFile: (file) => {
    if (file === "/proc/stat") return "btime 1700000000\n";
    if (file === "/proc/101/stat") throw Object.assign(new Error("denied"), { code: statError });
    if (file === "/proc/102/stat") return stat(102, "node");
    if (file === "/proc/101/cmdline") return "python3\0/home/u/.local/bin/hermes\0--tui\0";
    if (file === "/proc/102/cmdline") return "node\0fixture.mjs\0";
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  } });
  const denied = linux("EACCES");
  assert.equal(denied.get(101)?.startedAtMs, null, "a process whose stat could not be read was dropped");
  assert.deepEqual(hermesProcesses(denied).running, [101]);
  assert.equal(linux("ENOENT").has(101), false, "CONTROL: a process gone between listing and reading is dropped");
  const win = parseCommandTable("101\t1\t\thermes.exe\t1\tC:\\fixture\\hermes.exe --tui\n102\t1\t2026-10-01T00:00:00.0000000Z\tnode.exe\t1\tnode x", { platform: "win32" });
  assert.equal(win.get(101)?.startedAtMs, null, "a process with no CreationDate was dropped");
  assert.deepEqual(hermesProcesses(win).running, [101]);
});

test("WINDOWS PRODUCER: the real PowerShell pipeline keeps a process CIM gives no CreationDate", { skip: process.platform !== "win32" && "needs PowerShell" }, () => {
  // Synthetic CIM objects in place of the host's inventory; the rest of the script is processTable's own.
  const ps = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const fixture = "$fixture=@([pscustomobject]@{ProcessId=101;ParentProcessId=1;CreationDate=$null;Name='hermes.exe';CommandLine='C:\\fixture\\hermes.exe --tui'},"
    + "[pscustomobject]@{ProcessId=102;ParentProcessId=1;CreationDate=[datetime]'2026-10-01T00:00:00Z';Name='node.exe';CommandLine='C:\\fixture\\node.exe x'});\n";
  const run = (command, args, options) => {
    const script = args.at(-1);
    assert.equal(script.split("Get-CimInstance Win32_Process").length, 2, "the producer's script changed shape");
    return spawnSync(ps, [...args.slice(0, -1), fixture + script.replace("Get-CimInstance Win32_Process", "$fixture")], { ...options, timeout: 20_000 });
  };
  const rows = processTable({ platform: "win32", commands: true, run });
  assert.deepEqual([rows.get(101)?.image, rows.get(101)?.startedAtMs], ["hermes", null]);
  assert.equal(typeof rows.get(102)?.startedAtMs, "number", "CONTROL: a timed row keeps its start");
  assert.equal(processTable({ platform: "win32", run }).has(101), false, "the lease's table gained an untimed row");
});

/** A marker in a temp home, with a recording scan and step; every start is for `target` unless `apply` is told another. */
function world({ running = [], tableReadable = true, stepOk = true, current = false } = {}) {
  const dir = temp();
  const pending = new PendingHermesConfig({ marker: path.join(dir, ".aify", "hermes-config-pending.json") });
  const calls = { scans: 0, steps: [], plans: [] };
  // The step's plan: whether the config already holds the registry's servers (`current`), so a write would change nothing.
  const plan = (registry) => {
    calls.plans.push(registry);
    return { ok: true, current, detail: "" };
  };
  const scan = () => {
    calls.scans += 1;
    return tableReadable ? table([...NOT_HERMES, ...running]) : null;
  };
  const step = (registry) => {
    calls.steps.push(registry);
    return stepOk ? { ok: true, detail: "" } : { ok: false, detail: "the hermes config step exited 78, its reason above" };
  };
  return { dir, pending, calls, record: (registry, target = TARGET) => pending.record(registry, target),
    apply: (target = TARGET) => pending.apply({ scan, step, plan, target }),
    install: (registry, target = TARGET) => pending.install({ registry, target, scan, step, plan }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("nothing pending: nothing is scanned or run", () => {
  const w = world();
  try {
    assert.deepEqual(w.apply(), { outcome: "none", detail: "nothing pending" });
    assert.deepEqual(w.calls, { scans: 0, steps: [], plans: [] });
  } finally {
    w.cleanup();
  }
});

test("hermes running: the change waits, named, and the marker stays; a quiet host applies it once and removes the marker", () => {
  const busy = world({ running: [HERMES[1]] });
  try {
    busy.record(path.join(busy.dir, "services.json"));
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
    quiet.record(path.join(quiet.dir, "services.json"));
    assert.equal(quiet.apply().outcome, "applied");
    assert.deepEqual(quiet.calls.steps, [path.join(quiet.dir, "services.json")]);
    assert.equal(quiet.pending.read().state, "none");
  } finally {
    quiet.cleanup();
  }
});

test("A CHANGE THAT WRITES NOTHING IS RETIRED, hermes running or not: only a write reloads a running hermes", () => {
  // A reinstall (2026-10-29) left a change pending for a config that already held it, until a quiet start.
  for (const running of [[HERMES[1]], []]) {
    const w = world({ running, current: true });
    try {
      w.record(path.join(w.dir, "services.json"));
      const result = w.apply();
      assert.equal(result.outcome, "current", result.detail);
      assert.match(result.detail, /writes nothing the config does not already hold, and is retired/);
      assert.deepEqual(w.calls.steps, [], "the step ran for a change that writes nothing");
      assert.equal(w.pending.read().state, "none");
    } finally {
      w.cleanup();
    }
  }
});

test("AN INSTALL THAT CHANGES NOTHING records nothing, and retires a change recorded for its registry and config only", () => {
  const registry = (w, name = "services.json") => path.join(w.dir, name);
  const fresh = world({ running: [HERMES[1]], current: true });
  try {
    assert.equal(fresh.install(registry(fresh)).outcome, "current");
    assert.equal(fresh.pending.read().state, "none", "an install with nothing to write recorded a change");
    assert.deepEqual([fresh.calls.scans, fresh.calls.steps], [0, []]);
  } finally {
    fresh.cleanup();
  }
  const stale = world({ running: [HERMES[1]], current: true });
  try {
    stale.record(registry(stale));
    const result = stale.install(registry(stale));
    assert.match(result.detail, /already holds these servers; the change recorded at .* is retired/);
    assert.equal(stale.pending.read().state, "none");
  } finally {
    stale.cleanup();
  }
  for (const [name, target] of [["other.json", TARGET], ["services.json", path.join(os.tmpdir(), "hermes-home-b", "config.yaml")]]) {
    const other = world({ running: [HERMES[1]], current: true });
    try {
      other.record(registry(other, name), target);
      other.install(registry(other));
      assert.equal(other.pending.read().state, "pending", `a change recorded for ${name} at ${target} was retired by an install of another`);
    } finally {
      other.cleanup();
    }
  }
  // CONTROL: with something to write the install records it, and a quiet host applies it.
  const changing = world({ current: false });
  try {
    assert.equal(changing.install(registry(changing)).outcome, "applied");
    assert.deepEqual(changing.calls.steps, [registry(changing)]);
  } finally {
    changing.cleanup();
  }
});

test("lockBudget: the hold's one deadline is the lock's age limit less a margin, and nothing more starts with too little left", () => {
  const rows = [
    // [what, input, deadlineMs, leftMs]
    ["a twelve-minute lock keeps a minute back", { acquiredMs: 0, staleMs: 720_000, nowMs: 0, minimumMs: 30_000 }, 660_000, 660_000],
    ["a short lock keeps a quarter back", { acquiredMs: 1_000, staleMs: 4_000, nowMs: 1_000, minimumMs: 500 }, 4_000, 3_000],
    ["time spent under the lock is gone from what is left", { acquiredMs: 0, staleMs: 720_000, nowMs: 540_000, minimumMs: 30_000 }, 660_000, 120_000],
    ["exactly the minimum left still starts", { acquiredMs: 0, staleMs: 720_000, nowMs: 630_000, minimumMs: 30_000 }, 660_000, 30_000],
    ["less than the minimum left starts nothing", { acquiredMs: 0, staleMs: 720_000, nowMs: 630_001, minimumMs: 30_000 }, 660_000, 0],
    ["past the deadline starts nothing", { acquiredMs: 0, staleMs: 720_000, nowMs: 700_000, minimumMs: 30_000 }, 660_000, 0],
  ];
  for (const [what, input, deadlineMs, leftMs] of rows) assert.deepEqual(lockBudget(input), { deadlineMs, leftMs }, what);
});

/** Block this process for `ms`, as a slow plan or step holds the lock. */
const busyFor = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
/** A pending change under a short lock, recorded for TARGET, that a quiet host would apply. */
function shortLock(staleMs = 4_000) {
  const dir = temp();
  const marker = path.join(dir, ".aify", "hermes-config-pending.json");
  const pending = new PendingHermesConfig({ marker, lockMs: staleMs, minimumMs: 500 });
  pending.record(path.join(dir, "services.json"), TARGET);
  return { dir, marker, pending, quiet: () => table(NOT_HERMES) };
}

test("ONE BUDGET: the plan and the step share the hold's deadline, and a step with too little of it left is not started", () => {
  // Review of 72405ab: a plan and a step had ten minutes each under a lock taken from a live holder after twelve.
  const fast = shortLock();
  try {
    const given = [];
    const result = fast.pending.apply({ scan: fast.quiet, target: TARGET,
      plan: (registry, { deadlineMs }) => { given.push(["plan", deadlineMs]); busyFor(1_000); return { ok: true, current: false }; },
      step: (registry, { deadlineMs }) => { given.push(["step", deadlineMs]); return { ok: true, detail: "" }; } });
    assert.equal(result.outcome, "applied", result.detail);
    assert.equal(given.length, 2);
    assert.equal(given[0][1], given[1][1], "the step was given a deadline of its own, not the hold's");
  } finally {
    fs.rmSync(fast.dir, { recursive: true, force: true });
  }
  const slow = shortLock();
  try {
    const steps = [];
    const result = slow.pending.apply({ scan: slow.quiet, target: TARGET,
      plan: () => { busyFor(2_700); return { ok: true, current: false }; },
      step: (registry) => { steps.push(registry); return { ok: true, detail: "" }; } });
    assert.equal(result.outcome, "deferred", result.detail);
    assert.match(result.detail, /too little of this start's hold on the lock is left/);
    assert.deepEqual(steps, [], "a step was started with less than its minimum left");
    assert.equal(slow.pending.read().state, "pending");
  } finally {
    fs.rmSync(slow.dir, { recursive: true, force: true });
  }
});

test("AN ENGAGED WAITING START does not get the lock while the holder's plan and step use the whole budget", async () => {
  // A plan longer than the margin (a quarter of the lock's age limit), so a step given a budget of its own would outlive
  // the lock; and room enough that a slow spawn of the waiter on a loaded host does not leave the step too little.
  const staleMs = 12_000;
  const held = shortLock(staleMs);
  const out = path.join(held.dir, "waiter.out");
  let waiter;
  let stepEnded = 0;
  try {
    const result = held.pending.apply({ scan: held.quiet, target: TARGET,
      plan: () => {
        const started = Date.now();
        waiter = spawn(process.execPath, [WAITER, `${held.marker}.lock`, String(staleMs), out], { stdio: "ignore" });
        busyFor(5_000 - (Date.now() - started));
        return { ok: true, current: false };
      },
      // A step that writes until its deadline: the slowest the budget allows.
      step: (registry, { deadlineMs }) => { busyFor(deadlineMs - Date.now()); stepEnded = Date.now(); return { ok: true, detail: "" }; } });
    assert.equal(result.outcome, "applied", result.detail);
    await new Promise((resolve) => waiter.on("exit", resolve));
    const lines = fs.readFileSync(out, "utf8").trim().split("\n");
    assert.equal(lines[0], "waiting", "control: the waiting start never asked for the lock");
    const acquired = Number(lines[1]?.split(" ")[1]);
    assert.ok(acquired >= stepEnded, `a waiting start took the lock ${stepEnded - acquired} ms before the holder's step ended`);
  } finally {
    waiter?.kill();
    fs.rmSync(held.dir, { recursive: true, force: true });
  }
});

test("A NEWER INSTALL'S CHANGE survives an install that found the config current: the plan and the retirement are one hold", async () => {
  // Review of 72405ab: a plan made before the lock deleted the marker a newer install recorded meanwhile.
  const w = world({ running: [HERMES[1]], current: true });
  const registry = path.join(w.dir, "services.json");
  let newer;
  try {
    const result = w.pending.install({ registry, target: TARGET, scan: () => table([HERMES[1]]), step: () => ({ ok: true, detail: "" }),
      plan: () => {
        // Another install records the same registry for the same config while this one is planning.
        newer = spawn(process.execPath, [RECORDER, w.pending.marker, registry, TARGET], { stdio: "ignore" });
        busyFor(1_500);
        return { ok: true, current: true, detail: "" };
      } });
    assert.equal(result.outcome, "current", result.detail);
    assert.equal(await new Promise((resolve) => newer.on("exit", resolve)), 0, "control: the newer install did not record");
    assert.equal(w.pending.read().state, "pending", "the newer install's change was retired on an older verdict");
  } finally {
    newer?.kill();
    w.cleanup();
  }
});

test("AN INSTALL WITH SOMETHING TO WRITE, while hermes runs, records it and writes nothing: the one gate every installer passes", () => {
  // aify-comms' installer wrote the dashboard's entry with 24 hermes running (2026-10-29): it ran the step directly.
  const busy = world({ running: [HERMES[1]], current: false });
  try {
    const result = busy.install(path.join(busy.dir, "services.json"));
    assert.equal(result.outcome, "deferred", result.detail);
    assert.deepEqual(busy.calls.steps, [], "the install wrote while hermes was running");
    assert.equal(busy.pending.read().registry, path.join(busy.dir, "services.json"));
  } finally {
    busy.cleanup();
  }
});

test("a python whose command line cannot be read holds the change back: it may be hermes", () => {
  const w = world({ running: [UNKNOWN[0]] });
  try {
    w.record(path.join(w.dir, "services.json"));
    const result = w.apply();
    assert.equal(result.outcome, "deferred");
    assert.match(result.detail, /cannot be read, so it may be hermes/);
    assert.deepEqual(w.calls.steps, []);
  } finally {
    w.cleanup();
  }
});

test("a host whose processes cannot be listed is not taken for a quiet one", () => {
  const w = world({ tableReadable: false });
  try {
    w.record(path.join(w.dir, "services.json"));
    const result = w.apply();
    assert.equal(result.outcome, "deferred");
    assert.match(result.detail, /cannot be listed/);
    assert.deepEqual(w.calls.steps, []);
  } finally {
    w.cleanup();
  }
});

test("a step that fails leaves the change pending", () => {
  const failing = world({ stepOk: false });
  try {
    failing.record(path.join(failing.dir, "services.json"));
    assert.equal(failing.apply().outcome, "failed");
    assert.equal(failing.pending.read().state, "pending");
  } finally {
    failing.cleanup();
  }
});

test("a change recorded for one hermes config is applied by a start of that config only; another start leaves it, named", () => {
  const w = world();
  const other = path.join(os.tmpdir(), "hermes-home-b", "config.yaml");
  try {
    w.record(path.join(w.dir, "services.json"));
    const left = w.apply(other);
    assert.equal(left.outcome, "deferred");
    assert.ok(left.detail.includes(TARGET) && left.detail.includes(other), left.detail);
    assert.deepEqual(w.calls, { scans: 0, steps: [], plans: [] }, "a start of another config scanned, planned or wrote");
    assert.equal(w.pending.read().state, "pending");
    assert.equal(w.apply(null).outcome, "deferred", "a start whose config cannot be resolved is not taken for the right one");
    assert.equal(w.apply().outcome, "applied", "CONTROL: the start of the recorded config applies it");
    assert.deepEqual(w.calls.steps, [path.join(w.dir, "services.json")]);
  } finally {
    w.cleanup();
  }
});

test("a config is the one hermes writes: HERMES_HOME as written, else the platform's root; one hermes would expand is unresolvable", () => {
  const home = path.join(os.tmpdir(), "u");
  const at = (env, platform = "linux") => hermesConfigTarget({ env, platform, homedir: home });
  assert.equal(at({ HERMES_HOME: path.join(os.tmpdir(), "hh") }), path.resolve(os.tmpdir(), "hh", "config.yaml"));
  assert.equal(at({}), path.resolve(home, ".hermes", "config.yaml"));
  assert.equal(at({ LOCALAPPDATA: path.join(home, "L") }, "win32"), path.resolve(home, "L", "hermes", "config.yaml"));
  for (const HERMES_HOME of ["~/h", "$HOME/h", "%USERPROFILE%\\h"]) assert.equal(at({ HERMES_HOME }), null, HERMES_HOME);
  assert.equal(sameTarget("C:\\H\\config.yaml", "c:\\h\\CONFIG.yaml", "win32"), true);
  assert.equal(sameTarget("/h/config.yaml", "/H/config.yaml", "linux"), false);
});

test("the record names the registry and its config, nothing else: no entry, so no key, is written to disk", () => {
  const w = world();
  try {
    w.record("relative/services.json");
    const body = JSON.parse(fs.readFileSync(w.pending.marker, "utf8"));
    assert.deepEqual(Object.keys(body).sort(), ["recordedAt", "registry", "target", "version"]);
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
    // A short wait behind a holder that is not yet stale: in use the two are the same, so the holder's apply bounds both.
    const pending = new PendingHermesConfig({ marker, lockMs: 300, lock: { staleMs: 60_000 } });
    pending.record(path.join(dir, "services.json"), TARGET);
    // This process holds the lock, and is alive for as long as the case runs.
    const held = new FileLock({ path: `${marker}.lock`, waitMs: 0, staleMs: 60_000 });
    held.hold(() => {
      assert.throws(() => new FileLock({ path: `${marker}.lock`, waitMs: 300, staleMs: 60_000 }).hold(() => {}), FileLockBusyError);
      assert.throws(() => pending.record(path.join(dir, "newer.json"), TARGET), FileLockBusyError, "a record landed while an apply held the lock");
      let stepped = false;
      const result = pending.apply({ scan: () => new Map(), step: () => { stepped = true; return { ok: true, detail: "" }; }, target: TARGET });
      assert.equal(result.outcome, "deferred");
      assert.match(result.detail, /another start still holds/);
      assert.equal(stepped, false);
      assert.equal(pending.read().state, "pending");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an install that records while an apply retires the marker is not lost: it waits for the apply, then lands", async () => {
  // The review's window: a record published after the apply's last comparison and before its removal was deleted
  // with the one applied. Here a second process asks to record at that moment; the apply waits up to 1.5 s for it.
  const dir = temp();
  const marker = path.join(dir, ".aify", "hermes-config-pending.json");
  const newer = path.join(dir, "newer.json");
  let recorder = null;
  let landedFirst = false;
  const io = { ...fs, rmSync(file, ...rest) {
    if (file === marker && !recorder) {
      const before = fs.readFileSync(marker, "utf8");
      recorder = spawn(process.execPath, [RECORDER, marker, newer, TARGET], { stdio: "ignore" });
      for (let waited = 0; waited < 1_500 && fs.readFileSync(marker, "utf8") === before; waited += 50) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      landedFirst = fs.readFileSync(marker, "utf8") !== before;
    }
    return fs.rmSync(file, ...rest);
  } };
  try {
    const pending = new PendingHermesConfig({ marker, io });
    pending.record(path.join(dir, "services.json"), TARGET);
    assert.equal(pending.apply({ scan: () => new Map(), step: () => ({ ok: true, detail: "" }), target: TARGET }).outcome, "applied");
    assert.ok(recorder, "control: the recorder was never started, so this proves nothing");
    assert.equal(await new Promise((resolve) => recorder.on("exit", resolve)), 0, "the recorder failed");
    assert.equal(landedFirst, false, "a record landed inside the apply's hold");
    const left = pending.read();
    assert.equal(left.state, "pending", "the later record was lost");
    assert.equal(left.registry, newer);
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
    new PendingHermesConfig({ marker }).record(path.join(dir, "services.json"), TARGET);
    const go = path.join(dir, "go");
    const starts = Array.from({ length: 4 }, () => spawn(process.execPath, [RACER, marker, log, TARGET, go], { stdio: "ignore" }));
    const exits = starts.map((child) => new Promise((resolve) => child.on("exit", resolve)));
    // Every start is released at once, when all four are ready, however slowly the host spawned them.
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      if (fs.readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("ready ")).length === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fs.writeFileSync(go, "");
    await Promise.all(exits);
    const entries = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")).filter(([word]) => word !== "ready");
    const lines = entries.map(([word]) => word);
    const begin = lines.indexOf("begin");
    const end = lines.indexOf("end");
    assert.equal(lines.filter((word) => word === "begin").length, 1, lines.join(" "));
    // The witness of overlap: another start, inside apply, found the lock taken while the applier held it.
    const holder = entries[begin][1];
    assert.ok(entries.slice(begin, end).some(([word, pid]) => word === "contend" && pid !== holder),
      `control: no start contended for the lock while it was held: ${lines.join(" ")}`);
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
    const { throughout, result: applied } = onThisHost(() => spawnSync(process.execPath, [CLI, "apply", "--marker", marker], { env, encoding: "utf8", timeout: 120_000 }));
    const sets = fs.readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith('["config","set"'));
    if (applied.status === OUTCOMES.applied) {
      assert.deepEqual(throughout, [], `applied while hermes ran here the whole time: ${applied.stderr}`);
      assert.match(applied.stderr, /is applied/);
      assert.equal(sets.length, 1, "applied without the installer's step");
      assert.equal(fs.existsSync(marker), false);
    } else {
      // This host runs hermes, as the development host does while its agents are up.
      assert.equal(applied.status, OUTCOMES.deferred, applied.stderr);
      assert.match(applied.stderr, HOST_DEFERRAL);
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
    const { throughout, result: run } = onThisHost(() => spawnSync("bash", [path.join(HERE, "..", "install.sh"), "--client", "hermes",
      "--endpoint", "http://127.0.0.2:1", "--dest", posix(path.join(dir, "bin")), "--bridge-dir", posix(path.join(dir, "bridge")),
      "--registry", posix(registry)], { encoding: "utf8", timeout: 180_000, env }));
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, "bin", "hermes-aify")), "the launcher was not installed");
    const sets = fs.readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith('["config","set"'));
    const marker = path.join(dir, ".aify", "hermes-config-pending.json");
    if (/the change is pending/.test(run.stdout)) {
      assert.match(run.stdout, HOST_DEFERRAL);
      assert.deepEqual(sets, [], "the install wrote the hermes config while hermes was running");
      assert.equal(new PendingHermesConfig({ marker }).read().registry, path.resolve(registry));
    } else {
      assert.deepEqual(throughout, [], `the install wrote the hermes config while hermes ran here the whole time: ${run.stderr}`);
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
  "  runtimeFirst: fs.existsSync(process.env.STUB_RUNTIME_ENV), markerSeen: fs.existsSync(process.argv[4]) })}\\n`);",
  "process.exit(Number(process.env.STUB_STEP_EXIT));",
  "",
].join("\n");

test("hermes-aify runs the step before its hermes when a change is pending, with its own hermes command; it starts either way", () => {
  const files = { "wrapper/bin/aify-hermes-pending-config.mjs": STEP_STUB, "<home>/.aify/hermes-config-pending.json": "{}" };
  // With MSYS_NO_PATHCONV=1 too (`rewriting: false`): bash's /c/... path reached node unconverted and read as absent
  // (review of ba87799), so the launcher converts it itself.
  for (const [code, said, rewriting] of [["0", null, true], ["75", null, true], ["78", /the pending hermes config step exited 78; this start goes on without it/, true],
    ["0", null, false]]) {
    const { run, started, home } = launch("hermes", ["--aify-agent", "lead", "chat"], { definitions: { lead: definition }, files, rewriting, env: { STUB_STEP_EXIT: code } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(started.PATH, "the runtime did not start");
    const step = JSON.parse(/^STEP (.*)$/m.exec(run.stderr)?.[1] ?? "null");
    assert.ok(step, `the step did not run: ${run.stderr}`);
    assert.deepEqual(step.args.slice(0, 2), ["apply", "--marker"]);
    const at = (file) => path.resolve(file).toLowerCase();
    assert.equal(at(step.args[2]), at(path.join(home, ".aify", "hermes-config-pending.json")));
    assert.equal(step.markerSeen, true, `node could not find the marker it was handed (rewriting ${rewriting}): ${step.args[2]}`);
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
