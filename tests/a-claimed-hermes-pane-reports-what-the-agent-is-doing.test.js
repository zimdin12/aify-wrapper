#!/usr/bin/env node
// A Herdr pane running hermes-aify must show whether the agent is working.
//
// Same defect as claude-aify (a-claimed-pane-reports-what-the-agent-is-doing.test.js). Hermes runs
// hooks only for plugins listed in `plugins.enabled`, so the hooks ride on the aify-comms plugin
// hermes-aify already enables: the launcher names lib/hermes-herdr-state.py in
// AIFY_HERDR_HERMES_PLUGIN, and that plugin's loader hands it the PluginContext (tested in
// aify-comms, service/tests/test_hermes_plugin_hands_herdr_its_context.py).
//
// These run the rendered launcher with a stub `hermes` that keeps the environment it was given, then
// load the plugin that environment names with a fake PluginContext and call the hooks it registered
// with the arguments hermes passes. What reaches the stub `herdr` is the assertion.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AIFY_AGENT_SOURCE } from "../lib/herdr-pane.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const PLUGIN = path.join(ROOT, "lib", "hermes-herdr-state.py");
const NOWHERE = "http://127.0.0.2:1";
const PYTHON = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const WIN = process.platform === "win32" && "the stub herdr is a shell script, which Windows cannot spawn by path";
const NO_PYTHON = WIN || (!PYTHON && "python3 is not on PATH");

// Registers the plugin against a context that records hooks, then runs the named hooks in order with
// the keyword arguments hermes uses at their call sites.
const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("herdr_state", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Ctx:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)
ctx = Ctx()
module.register(ctx)
print(json.dumps(sorted(ctx.hooks)))
for name, kwargs in json.loads(sys.argv[2]):
    for callback in ctx.hooks.get(name, []):
        assert callback(**kwargs) is None
`;

function launch({ env = {}, listFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-dot-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  for (const d of [out, stubs, home, path.join(bridge, "node_modules")]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(ROOT, path.join(bridge, "node_modules", "aify-wrapper"), "dir");

  const rendered = spawnSync("bash", [INSTALL, "--client", "hermes", "--endpoint", NOWHERE,
    "--render-only", out, "--bridge-dir", bridge], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  const seen = path.join(dir, "hermes-env.json");
  fs.writeFileSync(path.join(stubs, "hermes"), [
    "#!/bin/sh",
    `exec '${process.execPath}' -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), agent: process.env.AIFY_HERDR_AGENT ?? null, plugin: process.env.AIFY_HERDR_HERMES_PLUGIN ?? null }))' '${seen}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });

  const calls = path.join(dir, "herdr-calls");
  const herdr = path.join(stubs, "herdr");
  fs.writeFileSync(herdr, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${calls}'`,
    'if [ "$1 $2" = "pane list" ]; then',
    listFails ? "  exit 1" : `  printf '%s' '{"result":{"panes":[{"pane_id":"w1:p2","terminal_id":"term-1"}]}}'`,
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });

  const baseEnv = {
    PATH: [stubs, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: home,
    HERDR_BIN_PATH: herdr,
  };
  // A passthrough subcommand goes straight to the runtime, past every export the agent paths make.
  const run = spawnSync("bash", [path.join(out, "hermes-aify"), "model", "list"], {
    encoding: "utf8", env: { ...baseEnv, ...env }, timeout: 60_000,
  });
  assert.equal(run.status, 0, `launcher failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(seen), `hermes was never started:\n${run.stderr}`);
  const hermes = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.deepEqual(hermes.argv, ["model", "list"]);

  const reports = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "")
    .split("\n").filter(line => line.startsWith("pane report-agent"));
  /** Load the plugin hermes was told about, as the aify-comms loader does, and run hooks in order. */
  const fire = (events, pluginPath = hermes.plugin, extraEnv = {}) => {
    const hookEnv = { ...baseEnv, ...env, PYTHONDONTWRITEBYTECODE: "1", ...extraEnv };
    if (hermes.agent !== null && !("AIFY_HERDR_AGENT" in extraEnv)) hookEnv.AIFY_HERDR_AGENT = hermes.agent;
    const result = spawnSync(PYTHON, ["-c", DRIVER, pluginPath, JSON.stringify(events)], { encoding: "utf8", env: hookEnv });
    assert.equal(result.status, 0, `plugin failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { hermes, fire, reports };
}

const IN_A_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1", HARNESS_IDENTITY: "probe-agent" };
const states = (lines) => lines.map(line => line.split(" --state ")[1]);
const TURN = [
  ["pre_llm_call", { session_id: "s1", platform: "cli" }],
  ["pre_approval_request", { command: "rm -rf build", surface: "cli" }],
  ["post_approval_response", { command: "rm -rf build", surface: "cli", choice: "once" }],
  ["on_session_end", { session_id: "s1", completed: true, interrupted: false, platform: "cli" }],
];

test("A CLAIMED HERMES PANE FOLLOWS THE AGENT: working, blocked, working, idle", { skip: NO_PYTHON }, () => {
  const { hermes, fire, reports } = launch({ env: IN_A_PANE });
  assert.equal(hermes.agent, "hermes-aify");
  assert.equal(fs.realpathSync(hermes.plugin), fs.realpathSync(PLUGIN));
  assert.deepEqual(reports(), ["pane report-agent w1:p2 --source herdr:aify --agent hermes-aify --state idle"]);

  const registered = fire(TURN);
  assert.deepEqual(registered, ["on_session_end", "post_approval_response", "pre_approval_request", "pre_llm_call"]);
  assert.deepEqual(states(reports().slice(1)), ["working", "blocked", "working", "idle"]);
  for (const line of reports()) assert.match(line, new RegExp(`^pane report-agent w1:p2 --source ${AIFY_AGENT_SOURCE} --agent hermes-aify `));
});

test("a subagent's turn and an approval the auxiliary model decides do not move the dot", { skip: NO_PYTHON }, () => {
  const { fire, reports } = launch({ env: IN_A_PANE });
  fire([
    ["pre_llm_call", { session_id: "child", platform: "subagent" }],
    ["pre_approval_request", { command: "ls", surface: "smart" }],
    ["post_approval_response", { command: "ls", surface: "smart", choice: "once" }],
    ["on_session_end", { session_id: "child", completed: true, interrupted: false, platform: "subagent" }],
  ]);
  assert.equal(reports().length, 1, `only the claim's own report should be there: ${reports().join("\n")}`);
});

test("OUTSIDE HERDR hermes is given neither the agent nor the plugin", { skip: WIN }, () => {
  const { hermes, reports } = launch({ env: { HARNESS_IDENTITY: "probe-agent" } });
  assert.equal(hermes.agent, null);
  assert.equal(hermes.plugin, null);
  assert.deepEqual(reports(), []);
});

test("a hermes pane the claim did NOT take gets neither", { skip: WIN }, () => {
  const { hermes, reports } = launch({ env: IN_A_PANE, listFails: true });
  assert.equal(hermes.agent, null);
  assert.equal(hermes.plugin, null);
  assert.deepEqual(reports(), []);
});

test("A MANAGED HERMES WORKER reports to the pane aify-env names, and claims nothing", { skip: NO_PYTHON }, () => {
  const paneFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-dot-pane-")), "pane");
  const { hermes, fire, reports } = launch({ env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_HERDR_PANE_FILE: paneFile } });
  assert.equal(hermes.agent, "hermes-aify");
  assert.deepEqual(reports(), [], "a managed worker claimed a pane");
  fire(TURN.slice(0, 1));
  assert.deepEqual(reports(), [], "reported before aify-env had named a pane");
  fs.writeFileSync(paneFile, "w2:p5\n");
  fire([TURN[0], TURN[3]]);
  assert.deepEqual(reports(), [
    "pane report-agent w2:p5 --source herdr:aify --agent hermes-aify --state working",
    "pane report-agent w2:p5 --source herdr:aify --agent hermes-aify --state idle",
  ]);
});

test("the plugin reports nothing without the agent variable", { skip: NO_PYTHON }, () => {
  const { fire, reports } = launch({ env: IN_A_PANE });
  fire(TURN, PLUGIN, { AIFY_HERDR_AGENT: "" });
  assert.equal(reports().length, 1);
});
