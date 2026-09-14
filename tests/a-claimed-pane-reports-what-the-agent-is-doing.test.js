#!/usr/bin/env node
// A Herdr pane running claude-aify must show whether the agent is working.
//
// THE DEFECT. The claim reports the agent under `herdr:aify` so Herdr will not resume a bare
// `claude` into the pane. Herdr 0.9.0 shows a claimed pane's state from the claim, not from its own
// screen detection (`recompute_effective_state`), and the claim said `idle` once. Every aify pane
// read idle for its whole life, including one whose agent was visibly mid-turn.
//
// These run the rendered launcher with a stub `claude` that keeps the settings file it was given and
// a stub `herdr` that records what it was asked, then run the hook commands from that file the way
// Claude would. The assertion is about what reaches Herdr, not about what the template says.

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
const STATE_SCRIPT = path.join(ROOT, "bin", "aify-herdr-state.sh");
const NOWHERE = "http://127.0.0.2:1";
// NOT RUN ON WINDOWS: the claim spawns HERDR_BIN_PATH directly and Windows cannot spawn a shell
// script by path, and the bridge directory is a symlink.
const WIN = process.platform === "win32" && "the stub herdr is a shell script, which Windows cannot spawn by path";

function launch({ env = {}, listFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-dot-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  for (const d of [out, stubs, home, path.join(bridge, "node_modules")]) fs.mkdirSync(d, { recursive: true });
  // The launcher finds the helper and the state script under the bridge's node_modules, as installed.
  fs.symlinkSync(ROOT, path.join(bridge, "node_modules", "aify-wrapper"), "dir");

  const rendered = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE,
    "--render-only", out, "--bridge-dir", bridge], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  const settings = path.join(dir, "settings.json");
  const agentVar = path.join(dir, "agent-var");
  const launchVar = path.join(dir, "launch-var");
  fs.writeFileSync(path.join(stubs, "claude"), [
    "#!/bin/sh",
    `printf '%s' "\${AIFY_HERDR_AGENT:-}" > '${agentVar}'`,
    `printf '%s' "\${AIFY_HERDR_LAUNCH:-}" > '${launchVar}'`,
    'while [ $# -gt 0 ]; do',
    `  if [ "$1" = "--settings" ]; then cp "$2" '${settings}'; fi`,
    "  shift",
    "done",
    "exit 0",
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
    PATH: [stubs, path.dirname(process.execPath), path.dirname(spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim()), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    HARNESS_IDENTITY: "probe-agent",
    HERDR_BIN_PATH: herdr,
    // The state script keeps its last report under TMPDIR; each launch gets its own.
    TMPDIR: dir,
  };
  const run = spawnSync("bash", [path.join(out, "claude-aify")], {
    encoding: "utf8", env: { ...baseEnv, ...env }, timeout: 60_000,
  });
  assert.equal(run.status, 0, `launcher failed: ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(settings), `no --settings was passed:\n${run.stderr}`);

  const config = JSON.parse(fs.readFileSync(settings, "utf8"));
  const hookEnv = {
    ...baseEnv, ...env,
    AIFY_HERDR_AGENT: fs.readFileSync(agentVar, "utf8"),
    AIFY_HERDR_LAUNCH: fs.readFileSync(launchVar, "utf8"),
  };
  const reports = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "")
    .split("\n").filter(line => line.startsWith("pane report-agent"));
  /** Run every command hook registered for one event, as Claude would. */
  const fire = (event) => {
    for (const group of config.hooks[event] || []) {
      for (const hook of group.hooks) {
        if (!hook.command.includes("aify-herdr-state.sh")) continue;
        const result = spawnSync("sh", ["-c", hook.command], { input: "{}", encoding: "utf8", env: hookEnv });
        assert.equal(result.status, 0, `${event} hook failed: ${result.stderr}`);
        assert.equal(result.stdout, "", `${event} hook printed into the agent's hook output`);
      }
    }
  };
  return { config, fire, reports, hookEnv };
}

const IN_A_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" };

test("A CLAIMED PANE FOLLOWS THE AGENT: working, blocked, working again, idle", { skip: WIN }, () => {
  const { config, fire, reports } = launch({ env: IN_A_PANE });
  // The one idle report is the claim's own, made at launch.
  assert.deepEqual(reports(), ["pane report-agent w1:p2 --source herdr:aify --agent claude-aify --state idle"]);

  fire("UserPromptSubmit");
  fire("Notification");
  fire("PostToolUse");
  fire("Stop");
  const states = reports().slice(1).map(line => line.split(" --state ")[1]);
  assert.deepEqual(states, ["working", "blocked", "working", "idle"]);
  // A turn that a failed tool keeps going and an API error ends: neither runs PostToolUse or Stop.
  fire("UserPromptSubmit");
  fire("Notification");
  fire("PostToolUseFailure");
  fire("StopFailure");
  assert.deepEqual(reports().slice(5).map(line => line.split(" --state ")[1]), ["working", "blocked", "working", "idle"]);
  for (const line of reports()) assert.match(line, /^pane report-agent w1:p2 --source herdr:aify --agent claude-aify /);

  // Only prompts that wait on a person make it blocked; an idle-at-prompt notice is not one.
  const [notification] = config.hooks.Notification;
  assert.ok(new RegExp(notification.matcher).test("permission_prompt"));
  assert.ok(!new RegExp(`^(?:${notification.matcher})$`).test("idle_prompt"));
  // The session-id hook the launcher always had is still there, first.
  assert.match(config.hooks.UserPromptSubmit[0].hooks[0].command, /claude-session-hook\.js/);
});

test("AN UNCHANGED STATE IS NOT SENT: a tool call per hook does not cost a Herdr round trip each", { skip: WIN }, () => {
  const { fire, reports, hookEnv } = launch({ env: IN_A_PANE });
  assert.match(hookEnv.AIFY_HERDR_LAUNCH, /^[0-9]+$/, "the launcher exported no launch id for the hooks");
  fire("UserPromptSubmit");
  for (let i = 0; i < 5; i += 1) fire("PostToolUse");
  fire("Stop");
  fire("Stop");
  assert.deepEqual(reports().slice(1).map(line => line.split(" --state ")[1]), ["working", "idle"]);

  // CONTROL: another launch in the same pane id starts clean, so its first report is not skipped.
  const other = { ...hookEnv, AIFY_HERDR_LAUNCH: `${hookEnv.AIFY_HERDR_LAUNCH}9` };
  const again = spawnSync("sh", [STATE_SCRIPT, "idle"], { input: "", encoding: "utf8", env: other });
  assert.equal(again.status, 0);
  assert.equal(reports().length, 4, "a different launch's idle was skipped as a repeat");
});

test("OUTSIDE HERDR the settings are exactly what they were", { skip: WIN }, () => {
  const { config, reports } = launch();
  assert.deepEqual(Object.keys(config.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  assert.equal(config.hooks.UserPromptSubmit[0].hooks.length, 1);
  assert.deepEqual(reports(), []);
});

test("a pane the claim did NOT take gets no state hooks", { skip: WIN }, () => {
  // Reporting under the aify source on a pane nobody recorded would take it from Herdr's own resume
  // with nothing to put back, which is the failure the claim is careful to avoid.
  const { config, reports } = launch({ env: IN_A_PANE, listFails: true });
  assert.deepEqual(Object.keys(config.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  assert.deepEqual(reports(), []);
});

test("A MANAGED WORKER reports to the pane aify-env names, once it names one", { skip: WIN }, () => {
  const paneFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-dot-pane-")), "pane");
  const { fire, reports } = launch({ env: { AIFY_HERDR_PANE_FILE: paneFile } });
  fire("UserPromptSubmit");
  assert.deepEqual(reports(), [], "reported before aify-env had opened a pane to report to");
  fs.writeFileSync(paneFile, "w2:p5\n");
  fire("UserPromptSubmit");
  assert.deepEqual(reports(), ["pane report-agent w2:p5 --source herdr:aify --agent claude-aify --state working"]);
  fs.writeFileSync(paneFile, "not a pane\n");
  fire("Stop");
  assert.equal(reports().length, 1, "a malformed pane id was passed to Herdr");
});

test("the state script reports under the source the claim uses", () => {
  // Herdr refuses a report from a source other than the claim's, so a drift here would silently
  // stop every dot again.
  const script = fs.readFileSync(STATE_SCRIPT, "utf8");
  assert.ok(script.includes(`--source ${AIFY_AGENT_SOURCE} `), `the script does not report under ${AIFY_AGENT_SOURCE}`);
});
