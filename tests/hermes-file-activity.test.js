#!/usr/bin/env node
// File activity from a hermes session, as bin/aify-tool-event.mjs records it from Claude Code (aify-dashboard #53).
//
// Hermes calls post_tool_call with tool_name, args, task_id, session_id, tool_call_id and status after each tool
// (hermes d923a5eb487, model_tools.py). lib/hermes-file-activity.py is that callback. It records only read_file,
// write_file and patch's own `path`, resolved by hermes' own resolver for the task (tools/file_tools_paths.py), and
// hands the event to bin/aify-hermes-file-event.mjs without waiting, so a tool call is not slowed by a node start.
// These prove the adapter's record, what the callback refuses, that it never waits, and one line written end to end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { hermesActivityEvent, validActivityRecord, activityEvent } from "../lib/file-activity.mjs";
import { withoutAgentSession } from "../lib/inherited-session.mjs";
import { emptyRegistry } from "./sealed-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = path.join(ROOT, "lib", "hermes-file-activity.py");
const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["--version"], { encoding: "utf8" }).status === 0);
const NO_PYTHON = !PYTHON && "neither python3 nor python runs here";
const identity = { agentId: "hermes-lead", instanceId: "residents", machineId: "win32:host", incarnation: "inc-1" };
const input = (over = {}) => ({ tool_name: "read_file", raw: "docs/a.md", canonical: "C:/work/repo/docs/a.md", session_id: "s1", tool_call_id: "c1", ...over });

test("the three file tools become read and write records of the hermes adapter", () => {
  for (const [tool, operation] of [["read_file", "read"], ["write_file", "write"], ["patch", "write"]]) {
    const record = hermesActivityEvent({ input: input({ tool_name: tool }), identity, outcome: "success", observedAt: 5 });
    assert.ok(record, tool);
    assert.equal(record.adapter, "hermes-file-path-v1");
    assert.equal(record.source.runtime, "hermes");
    assert.deepEqual([record.event.tool, record.event.operation, record.event.toolCallId], [tool, operation, "c1"]);
    assert.deepEqual(record.event.path, { raw: "docs/a.md", canonical: "C:/work/repo/docs/a.md" });
    assert.equal(validActivityRecord(record), true);
  }
});

test("any other tool, a relative or missing canonical path, or a missing session records nothing", () => {
  for (const over of [{ tool_name: "terminal" }, { tool_name: "search_files" }, { tool_name: "Read" }, { canonical: "docs/a.md" },
    { canonical: "" }, { canonical: undefined }, { raw: "" }, { session_id: "" }, { canonical: "C:docs/a.md" }]) {
    assert.equal(hermesActivityEvent({ input: input(over), identity, outcome: "success", observedAt: 5 }), null, JSON.stringify(over));
  }
});

test("a record of one adapter cannot pass as the other's", () => {
  const hermes = hermesActivityEvent({ input: input(), identity, outcome: "success", observedAt: 5 });
  assert.equal(validActivityRecord({ ...hermes, source: { ...hermes.source, runtime: "claude" } }), false);
  assert.equal(validActivityRecord({ ...hermes, adapter: "claude-file-path-v1" }), false);
  const claude = activityEvent({ input: { session_id: "s1", cwd: "C:\\work", tool_name: "Read", tool_input: { file_path: "C:\\work\\a.md" } },
    identity, outcome: "success", observedAt: 5 });
  assert.equal(validActivityRecord(claude), true, "the Claude adapter's records still pass");
  assert.equal(validActivityRecord({ ...claude, event: { ...claude.event, tool: "read_file" } }), false);
});

// Loads the module against a fake hermes resolver and a context that records hooks, replaces its hand-off with a
// recorder, then calls post_tool_call with hermes' keyword arguments once per call given.
const DRIVER = `
import importlib.util, json, logging, pathlib, sys, time, types
options = json.loads(sys.argv[2])
warnings = []
class Collect(logging.Handler):
    def emit(self, record):
        warnings.append(record.getMessage())
logging.getLogger("aify_file_activity").addHandler(Collect())
paths = types.ModuleType("tools.file_tools_paths")
def resolve(filepath, task_id="default"):
    if options.get("resolverRaises"):
        raise RuntimeError("resolver")
    return pathlib.PureWindowsPath("C:/work/repo") / filepath
paths._resolve_path_for_task = resolve
paths._terminal_env_type_for_task = lambda task_id="default": options.get("envType", "local")
paths._uses_container_paths = lambda task_id="default": options.get("container", False)
tools = types.ModuleType("tools")
tools.file_tools_paths = paths
sys.modules["tools"] = tools
sys.modules["tools.file_tools_paths"] = paths
spec = importlib.util.spec_from_file_location("aify_file_activity", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for name, value in options.get("attrs", {}).items():
    setattr(module, name, value)
sent = []
if not options.get("realHandOff"):
    module._hand_off = lambda payload, outcome: sent.append({"payload": payload, "outcome": outcome})
class Ctx:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)
ctx = Ctx()
module.register(ctx)
started = time.monotonic()
results = [callback(**call) for call in options["calls"] for callback in ctx.hooks.get("post_tool_call", [])]
took = time.monotonic() - started
in_flight = len(module._pending)
if options.get("release"):
    pathlib.Path(options["release"]).touch()
if options.get("realHandOff"):
    deadline = time.monotonic() + 15
    while module._pending and time.monotonic() < deadline:
        time.sleep(0.02)
print(json.dumps({"hooks": sorted(ctx.hooks), "results": results, "sent": sent, "took": took, "inFlight": in_flight, "warnings": warnings}))
`;

const call = (over = {}) => ({ tool_name: "read_file", args: { path: "docs/a.md" }, result: "{}", task_id: "t1", session_id: "s1",
  tool_call_id: "c1", turn_id: "", api_request_id: "", duration_ms: 3, status: "ok", error_type: null, error_message: null,
  middleware_trace: [], ...over });

function drive(options, env = process.env) {
  const run = spawnSync(PYTHON, ["-c", DRIVER, MODULE, JSON.stringify(options)], { encoding: "utf8", env: { ...env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("read_file, write_file and patch hand hermes' own resolved path to the producer, with the outcome", { skip: NO_PYTHON }, () => {
  const answer = drive({ calls: [call(), call({ tool_name: "write_file", args: { path: "out.txt", content: "x" }, status: "error" }),
    call({ tool_name: "patch", args: { mode: "replace", path: "docs/b.md", old_string: "a", new_string: "b" } })] });
  assert.deepEqual(answer.hooks, ["post_tool_call"]);
  assert.deepEqual(answer.results, [null, null, null], "an observer returns nothing to hermes");
  // Hermes' answer is handed over as hermes printed it; the adapter normalises separators (first test).
  assert.deepEqual(answer.sent.map((one) => [one.payload.tool_name, one.payload.raw, one.payload.canonical, one.outcome]), [
    ["read_file", "docs/a.md", "C:\\work\\repo\\docs\\a.md", "success"],
    ["write_file", "out.txt", "C:\\work\\repo\\out.txt", "failure"],
    ["patch", "docs/b.md", "C:\\work\\repo\\docs\\b.md", "success"]]);
  assert.deepEqual([answer.sent[0].payload.session_id, answer.sent[0].payload.tool_call_id], ["s1", "c1"]);
});

test("a shell tool, a patch with no path, a subagent's call, a remote task or a failing resolver hands nothing off", { skip: NO_PYTHON }, () => {
  assert.deepEqual(drive({ calls: [call({ tool_name: "terminal", args: { command: "cat docs/a.md" } }), call({ tool_name: "search_files", args: { path: "." } }),
    call({ tool_name: "patch", args: { mode: "patch", patch: "*** Begin Patch" } }), call({ parent_session_id: "parent" })] }).sent, []);
  assert.deepEqual(drive({ calls: [call()], envType: "ssh" }).sent, []);
  assert.deepEqual(drive({ calls: [call()], container: true }).sent, []);
  assert.deepEqual(drive({ calls: [call()], resolverRaises: true }).sent, []);
  assert.equal(drive({ calls: [call()] }).sent.length, 1, "positive control: the same call is handed off when nothing refuses it");
});

test("the tool call does not wait for the event writer", { skip: NO_PYTHON }, () => {
  // A writer that takes 3 s: a callback that waited could not return in under 1.5 s, however loaded the host is.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-slow-"));
  try {
    const slow = path.join(dir, "slow-writer.mjs");
    fs.writeFileSync(slow, "setTimeout(() => {}, 3000);\n");
    const answer = drive({ calls: [call()], realHandOff: true, attrs: { _EVENT: slow } });
    assert.ok(answer.took < 1.5, `post_tool_call returned in ${answer.took}s against a 3 s writer`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("at most eight writers run at once, and the calls above the cap are dropped", { skip: NO_PYTHON }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-cap-"));
  try {
    // Held until the driver has counted, not for a fixed time: on a loaded host twelve calls took 14.6 s, so a writer
    // that slept 3 s had exited, and freed its slot, before the count was taken.
    const held = (name) => {
      const release = path.join(dir, `${name}.release`), writer = path.join(dir, `${name}-writer.mjs`);
      fs.writeFileSync(writer, `import fs from "node:fs";\nconst at = Date.now();\nsetInterval(() => { if (fs.existsSync(${JSON.stringify(release)}) || Date.now() - at > 60000) process.exit(0); }, 20);\n`);
      return { realHandOff: true, attrs: { _EVENT: writer }, release };
    };
    const twelve = Array.from({ length: 12 }, (_, n) => call({ tool_call_id: `c${n}` }));
    assert.equal(drive({ calls: twelve, ...held("twelve") }).inFlight, 8);
    assert.equal(drive({ calls: twelve.slice(0, 3), ...held("three") }).inFlight, 3, "control: under the cap, every call starts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hermes resolver that fails is reported once, in hermes' log", { skip: NO_PYTHON }, () => {
  const answer = drive({ calls: [call(), call({ tool_call_id: "c2" })], resolverRaises: true });
  assert.deepEqual(answer.sent, []);
  assert.deepEqual(answer.warnings, ["hermes file paths unavailable: resolver"]);
  assert.deepEqual(drive({ calls: [call()] }).warnings, [], "a working resolver reports nothing");
});

test("the callback hands one line to the spool end to end", { skip: NO_PYTHON }, () => {
  const lease = fs.mkdtempSync(path.join(os.homedir(), "aify-hermes-activity-"));
  try {
    const env = { ...process.env, AIFY_FILE_ACTIVITY: "1", AIFY_AGENT_ID: "hermes-lead", AIFY_ENV_INSTANCE: "residents", AIFY_LIFETIME: "inc-1",
      AIFY_AGENT_LEASE_DIR: lease };
    drive({ calls: [call()], realHandOff: true }, env);
    const spool = path.join(lease, "hermes-lead", "activity-v2");
    const lines = fs.readdirSync(spool).flatMap((name) => fs.readFileSync(path.join(spool, name), "utf8").trim().split("\n"));
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]).record;
    assert.equal(validActivityRecord(record), true);
    assert.deepEqual([record.source.runtime, record.source.agentId, record.event.tool, record.event.path.canonical],
      ["hermes", "hermes-lead", "read_file", "C:/work/repo/docs/a.md"]);
    const off = { ...env, AIFY_FILE_ACTIVITY: "0", AIFY_AGENT_ID: "hermes-off" };
    drive({ calls: [call()], realHandOff: true }, off);
    assert.equal(fs.existsSync(path.join(lease, "hermes-off")), false, "with the switch off, nothing is written");
  } finally {
    fs.rmSync(lease, { recursive: true, force: true });
  }
});

/** Render hermes-aify and run `hermes-aify model list` against a stub hermes; the module it was named comes back. */
function launcherNames(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-activity-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const posix = (p) => p.split(path.sep).join("/");
  const out = path.join(dir, "out");
  const home = path.join(dir, "home");
  for (const d of [out, home, path.join(dir, "bridge")]) fs.mkdirSync(d, { recursive: true });
  const rendered = spawnSync("bash", [posix(path.join(ROOT, "install.sh")), "--registry", emptyRegistry(), "--client", "hermes",
    "--endpoint", "http://127.0.0.2:1", "--render-only", posix(out), "--bridge-dir", posix(path.join(dir, "bridge"))],
  { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);
  const seen = path.join(dir, "seen.json");
  const stub = path.join(dir, "hermes-stub");
  fs.writeFileSync(stub, ["#!/bin/sh",
    `exec '${posix(process.execPath)}' -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ plugin: process.env.AIFY_FILE_ACTIVITY_HERMES_PLUGIN ?? null }))' '${posix(seen)}'`,
    ""].join("\n"), { mode: 0o755 });
  const base = Object.fromEntries(Object.entries(withoutAgentSession(process.env)).filter(([name]) => !/^(AIFY_|HARNESS_|HERDR_)/.test(name)));
  const run = spawnSync("bash", [posix(path.join(out, "hermes-aify")), "model", "list"], {
    encoding: "utf8", timeout: 60_000,
    env: { ...base, HOME: home, USERPROFILE: home, AIFY_SERVICE_REGISTRY: emptyRegistry(), AIFY_HERMES_COMMAND: posix(stub), ...env },
  });
  assert.equal(run.status, 0, `launcher failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(seen), `hermes was never started:\n${run.stderr}`);
  return JSON.parse(fs.readFileSync(seen, "utf8")).plugin;
}

test("hermes-aify names the module only for an agent whose switch is on", (t) => {
  const named = launcherNames(t, { AIFY_AGENT_ID: "probe-agent", AIFY_FILE_ACTIVITY: "1" });
  assert.ok(named, "an agent with the switch on was not told where the module is");
  assert.equal(fs.realpathSync(named), fs.realpathSync(MODULE));
  assert.equal(launcherNames(t, { AIFY_AGENT_ID: "probe-agent" }), null, "the switch off still named the module");
  assert.equal(launcherNames(t, { AIFY_AGENT_ID: "probe-agent", AIFY_FILE_ACTIVITY: "0" }), null);
  assert.equal(launcherNames(t, { AIFY_FILE_ACTIVITY: "1" }), null, "a hermes with no agent was named the module");
});
