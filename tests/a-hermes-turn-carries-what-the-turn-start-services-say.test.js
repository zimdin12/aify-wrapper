#!/usr/bin/env node
// A hermes turn carries what the registry's turnStart services say, as a Claude Code turn does.
//
// Hermes adds what a pre_llm_call callback returns, {"context": text} or a str, to that turn's user message (hermes
// d923a5eb487, agent/turn_context.py _collect_pre_llm_call_context). lib/hermes-turn-start.py is that callback: it runs
// bin/aify-turn-start.mjs and hands back its text. The runner's own rules (the deadline, a refused key, a failing
// service) are proven in the-turn-start-runner-asks-every-service-in-time.test.js. These prove what the callback adds:
// the request it builds, the folder it names, the subagent skip, the guard on the agent's thread, and that no failure
// reaches hermes.
//
// They load the module with a fake PluginContext, as the aify-comms plugin hands it one, and call the callback with the
// keyword arguments hermes passes at its call site. The driver runs as a child process so this process's services can
// answer while it waits.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { withoutAgentSession } from "../lib/inherited-session.mjs";
import { emptyRegistry } from "./sealed-registry.mjs";
import { answer, host, KEY, service } from "./turn-start-host.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = path.join(ROOT, "lib", "hermes-turn-start.py");
const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["--version"], { encoding: "utf8" }).status === 0);
const NO_PYTHON = !PYTHON && "neither python3 nor python runs here";

// Loads the module against a context that records hooks, then calls pre_llm_call once with hermes' keyword arguments.
// `hermesCwd` stands in for hermes' own agent.runtime_cwd; `attrs` replaces module attributes, as a test of a guard must.
const DRIVER = `
import importlib.util, json, pathlib, sys, time, types
options = json.loads(sys.argv[3])
if options.get("hermesCwd") is not None:
    runtime_cwd = types.ModuleType("agent.runtime_cwd")
    runtime_cwd.resolve_agent_cwd = lambda: pathlib.Path(options["hermesCwd"])
    package = types.ModuleType("agent")
    package.runtime_cwd = runtime_cwd
    sys.modules["agent"] = package
    sys.modules["agent.runtime_cwd"] = runtime_cwd
spec = importlib.util.spec_from_file_location("hermes_turn_start", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for name, value in options.get("attrs", {}).items():
    setattr(module, name, value)
class Ctx:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)
ctx = Ctx()
module.register(ctx)
started = time.monotonic()
results = [callback(**json.loads(sys.argv[2])) for callback in ctx.hooks.get("pre_llm_call", [])]
print(json.dumps({"hooks": sorted(ctx.hooks), "results": results, "took": time.monotonic() - started}))
`;

// What hermes passes at agent/turn_context.py:809.
const TURN = { session_id: "hermes-session-7", task_id: "task-1", turn_id: "turn-1", user_message: "hi", conversation_history: [],
  is_first_turn: true, model: "probe-model", platform: "cli", parent_session_id: "", sender_id: "" };

/** Run the driver with `env`; `cwd` is the hermes process's launch folder. */
function fire(env, { turn = TURN, hermesCwd = null, attrs = {}, cwd = os.tmpdir() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", DRIVER, MODULE, JSON.stringify(turn), JSON.stringify({ hermesCwd, attrs })],
      { env: { ...env, PYTHONDONTWRITEBYTECODE: "1" }, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      // A callback that raised reaches here as a non-zero exit: hermes would have seen the exception.
      if (code !== 0) return reject(new Error(`the driver exited ${code}: ${stderr}`));
      resolve({ ...JSON.parse(stdout), output: stdout + stderr });
    });
  });
}

test("THE TURN CARRIES THE SERVICES' TEXT as hermes' context, asked with the session's id and hermes' own folder", { skip: NO_PYTHON }, async (t) => {
  const svc = await service(t, answer("OPERATOR RULE"));
  const launch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-launch-"));
  t.after(() => fs.rmSync(launch, { recursive: true, force: true }));
  const hermesCwd = path.join(os.tmpdir(), "hermes-session-workspace");
  const fired = await fire(host(t, { endpoint: svc.endpoint }), { hermesCwd, cwd: launch });
  assert.deepEqual(fired.hooks, ["pre_llm_call"]);
  assert.deepEqual(fired.results, [{ context: "OPERATOR RULE" }]);
  assert.equal(svc.seen.length, 1);
  const [seen] = svc.seen;
  assert.equal(seen.body.sessionKey, "hermes-session-7");
  // The folder hermes resolves for the session, not the process's launch folder: an agent placed by the wrong one
  // lands in another project, or in none, and is given that project's rules.
  assert.equal(seen.body.cwd, hermesCwd);
  assert.equal(seen.headers["x-aify-agent"], "probe-agent");
  assert.doesNotMatch(fired.output, new RegExp(KEY));
});

test("OUTSIDE HERMES, where its folder rule cannot be imported, the launch folder is named", { skip: NO_PYTHON }, async (t) => {
  const svc = await service(t, answer("OPERATOR RULE"));
  const launch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-launch-"));
  t.after(() => fs.rmSync(launch, { recursive: true, force: true }));
  const fired = await fire(host(t, { endpoint: svc.endpoint }), { cwd: launch });
  assert.deepEqual(fired.results, [{ context: "OPERATOR RULE" }]);
  assert.equal(fs.realpathSync(svc.seen[0].body.cwd), fs.realpathSync(launch));
});

test("A SUBAGENT'S TURN ASKS NOTHING AND ADDS NOTHING: its parent's turn already carried the rules", { skip: NO_PYTHON }, async (t) => {
  const svc = await service(t, answer("OPERATOR RULE"));
  const env = host(t, { endpoint: svc.endpoint });
  const fired = await fire(env, { turn: { ...TURN, platform: "subagent" } });
  assert.deepEqual(fired.results, [null]);
  assert.equal(svc.seen.length, 0, "a subagent's turn asked the service");
  // Control: the same host and service, on the parent's platform, are asked.
  assert.deepEqual((await fire(env)).results, [{ context: "OPERATOR RULE" }]);
  assert.equal(svc.seen.length, 1);
});

test("A RUNNER THAT NEVER EXITS IS STOPPED AT THE GUARD, and the turn goes on with nothing", { skip: NO_PYTHON, timeout: 20000 }, async (t) => {
  const svc = await service(t, answer("UNUSED"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-hang-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hang = path.join(dir, "hang.mjs");
  fs.writeFileSync(hang, "setInterval(() => {}, 1000);\n");
  const fired = await fire(host(t, { endpoint: svc.endpoint }), { attrs: { _RUNNER: hang, _GUARD_S: 1 } });
  assert.deepEqual(fired.results, [null]);
  assert.ok(fired.took >= 0.9 && fired.took < 4, `the callback took ${fired.took} s against a 1 s guard`);
});

/** Render hermes-aify and run `hermes-aify model list` against a stub hermes; what it saw in the environment comes back. */
function launcherHandsHermes(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-export-"));
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
    `exec '${posix(process.execPath)}' -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ plugin: process.env.AIFY_TURN_START_HERMES_PLUGIN ?? null }))' '${posix(seen)}'`,
    ""].join("\n"), { mode: 0o755 });
  // Not the session this suite runs in: a launcher inside one names no agent, whatever AIFY_AGENT_ID says.
  const base = Object.fromEntries(Object.entries(withoutAgentSession(process.env)).filter(([name]) => !/^(AIFY_|HARNESS_|HERDR_)/.test(name)));
  // A passthrough subcommand goes straight to the runtime: no gateway, no lease, nothing of the host's touched.
  const run = spawnSync("bash", [posix(path.join(out, "hermes-aify")), "model", "list"], {
    encoding: "utf8", timeout: 60_000,
    env: { ...base, HOME: home, USERPROFILE: home, AIFY_SERVICE_REGISTRY: emptyRegistry(), AIFY_HERMES_COMMAND: posix(stub), ...env },
  });
  assert.equal(run.status, 0, `launcher failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(seen), `hermes was never started:\n${run.stderr}`);
  return JSON.parse(fs.readFileSync(seen, "utf8")).plugin;
}

test("HERMES-AIFY NAMES THIS MODULE FOR AN AGENT, and a plain hermes is given nothing", async (t) => {
  const named = launcherHandsHermes(t, { AIFY_AGENT_ID: "probe-agent" });
  assert.ok(named, "an agent's hermes was not told where the turn-start module is");
  assert.equal(fs.realpathSync(named), fs.realpathSync(MODULE));
  assert.equal(launcherHandsHermes(t, {}), null, "a hermes with no agent was handed the turn-start module");
});

test("NO FAILURE REACHES HERMES: no node, a runner that prints no JSON, a runner that crashes", { skip: NO_PYTHON }, async (t) => {
  const svc = await service(t, answer("UNUSED"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-broken-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prose = path.join(dir, "prose.mjs");
  fs.writeFileSync(prose, "process.stdout.write('not json');\n");
  const crash = path.join(dir, "crash.mjs");
  fs.writeFileSync(crash, "throw new Error('broken runner');\n");
  const env = host(t, { endpoint: svc.endpoint });
  for (const [name, attrs] of [["no node", { _NODE: path.join(dir, "no-such-node.exe") }], ["prose", { _RUNNER: prose }], ["a crash", { _RUNNER: crash }]]) {
    assert.deepEqual((await fire(env, { attrs })).results, [null], name);
  }
});
