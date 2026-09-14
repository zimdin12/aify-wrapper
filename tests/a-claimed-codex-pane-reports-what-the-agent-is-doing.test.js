#!/usr/bin/env node
// A Herdr pane running codex-aify must show whether the agent is working.
//
// Same defect as claude-aify (a-claimed-pane-reports-what-the-agent-is-doing.test.js): the claim
// reports under `herdr:aify`, Herdr shows that report instead of its own screen detection, and the
// claim said `idle` once. codex-aify runs the agent inside a `codex app-server` it starts itself, so
// the hooks go on that process's command line as `-c hooks.<Event>=...`.
//
// These run the rendered launcher with a stub `codex` that keeps the app-server's argv and listens on
// its port, and a stub `herdr` that records what it was asked. Then they run the hook commands out of
// that argv the way codex would. What codex itself does with those flags, and when it refuses to run
// an untrusted hook, was measured against codex-cli 0.154.0 and is recorded in
// lib/codex-herdr-hooks.mjs; the hashes pinned at the bottom are the ones that codex wrote.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEX_STATE_EVENTS,
  codexHookArgs,
  codexHookHash,
  codexHookTrustKey,
  codexHooksTrusted,
  codexStateCommand,
} from "../lib/codex-herdr-hooks.mjs";
import { AIFY_AGENT_SOURCE } from "../lib/herdr-pane.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32" && "the stub herdr is a shell script, which Windows cannot spawn by path";

function launch({ env = {}, args = [], listFails = false, codexConfig = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-codex-dot-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  for (const d of [out, stubs, path.join(home, ".codex", "sessions"), path.join(bridge, "node_modules")]) fs.mkdirSync(d, { recursive: true });
  // A saved thread, so `--resume thread-1` takes the launcher's resume branch rather than starting fresh.
  fs.writeFileSync(path.join(home, ".codex", "sessions", "thread-1.jsonl"), "");
  fs.symlinkSync(ROOT, path.join(bridge, "node_modules", "aify-wrapper"), "dir");
  const stateScript = path.join(bridge, "node_modules", "aify-wrapper", "bin", "aify-herdr-state.sh");
  if (codexConfig) fs.writeFileSync(path.join(home, ".codex", "config.toml"), codexConfig(stateScript));

  const rendered = spawnSync("bash", [INSTALL, "--client", "codex", "--endpoint", NOWHERE,
    "--render-only", out, "--bridge-dir", bridge], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  // The app-server stub records one argument per line, then holds the port until the launcher kills it.
  const serverArgv = path.join(dir, "app-server-argv");
  const agentVar = path.join(dir, "agent-var");
  fs.writeFileSync(path.join(stubs, "codex"), [
    "#!/bin/bash",
    'for a in "$@"; do if [ "$a" = "app-server" ]; then',
    `  printf '%s\\n' "$@" > '${serverArgv}'`,
    `  printf '%s' "\${AIFY_HERDR_AGENT:-}" > '${agentVar}'`,
    '  url=""; prev=""; for b in "$@"; do [ "$prev" = "--listen" ] && url="$b"; prev="$b"; done',
    `  exec '${process.execPath}' -e 'require("net").createServer(s => s.end()).listen(Number(process.argv[1].split(":").pop()), "127.0.0.1")' "$url"`,
    "fi; done",
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
    PATH: [stubs, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: home,
    HARNESS_IDENTITY: "probe-agent",
    HERDR_BIN_PATH: herdr,
  };
  const run = spawnSync("bash", [path.join(out, "codex-aify"), ...args], {
    encoding: "utf8", env: { ...baseEnv, ...env }, timeout: 60_000,
  });
  assert.equal(run.status, 0, `launcher failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(serverArgv), `the app-server was never started:\n${run.stderr}`);

  const argv = fs.readFileSync(serverArgv, "utf8").split("\n").slice(0, -1);
  /** event -> command, parsed back out of the `-c hooks.<Event>=[...]` values codex was given. */
  const hooks = {};
  argv.forEach((value, i) => {
    const match = argv[i - 1] === "-c" && value.match(/^hooks\.(\w+)=\[\{hooks=\[\{type="command",command=("(?:[^"\\]|\\.)*"),timeout=3\}\]\}\]$/);
    if (match) hooks[match[1]] = JSON.parse(match[2]);
  });
  const hookEnv = { ...baseEnv, ...env, AIFY_HERDR_AGENT: fs.readFileSync(agentVar, "utf8") };
  const reports = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "")
    .split("\n").filter(line => line.startsWith("pane report-agent"));
  const fire = (event) => {
    assert.ok(hooks[event], `no ${event} hook was given to the app-server`);
    const result = spawnSync("sh", ["-c", hooks[event]], { input: "{}", encoding: "utf8", env: hookEnv });
    assert.equal(result.status, 0, `${event} hook failed: ${result.stderr}`);
    assert.equal(result.stdout, "", `${event} hook printed, and codex reads a hook's stdout as its answer`);
  };
  const claimLog = () => { try { return fs.readFileSync(path.join(home, ".aify", "herdr", "claim.log"), "utf8"); } catch { return ""; } };
  return { argv, hooks, fire, reports, hookEnv, claimLog, stateScript };
}

const IN_A_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" };
const states = (lines) => lines.map(line => line.split(" --state ")[1]);

test("A CLAIMED CODEX PANE FOLLOWS THE AGENT: working, blocked, working, idle, and idle after an interrupt", { skip: WIN }, () => {
  const { argv, hooks, fire, reports } = launch({ env: IN_A_PANE });
  assert.deepEqual(reports(), ["pane report-agent w1:p2 --source herdr:aify --agent codex-aify --state idle"]);
  assert.deepEqual(Object.keys(hooks).sort(), ["Interrupt", "PermissionRequest", "PostToolUse", "Stop", "UserPromptSubmit"]);
  // Before the subcommand: codex reads `-c` as a global flag.
  assert.ok(argv.indexOf("-c") < argv.indexOf("app-server"));

  for (const event of ["UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "UserPromptSubmit", "Interrupt"]) fire(event);
  assert.deepEqual(states(reports().slice(1)), ["working", "blocked", "working", "idle", "working", "idle"]);
  for (const line of reports()) assert.match(line, /^pane report-agent w1:p2 --source herdr:aify --agent codex-aify /);
});

test("OUTSIDE HERDR the app-server gets no hooks and the agent variable is unset", { skip: WIN }, () => {
  const { argv, hooks, hookEnv, reports } = launch();
  assert.deepEqual(hooks, {});
  assert.ok(!argv.includes("-c"), `unexpected -c on an ordinary launch: ${argv.join(" ")}`);
  assert.equal(hookEnv.AIFY_HERDR_AGENT, "");
  assert.deepEqual(reports(), []);
});

test("a codex pane the claim did NOT take gets no hooks", { skip: WIN }, () => {
  const { hooks, hookEnv, reports } = launch({ env: IN_A_PANE, listFails: true });
  assert.deepEqual(hooks, {});
  assert.equal(hookEnv.AIFY_HERDR_AGENT, "");
  assert.deepEqual(reports(), []);
});

test("a hook fired without the agent variable reports nothing", { skip: WIN }, () => {
  const { hooks, hookEnv, reports } = launch({ env: IN_A_PANE });
  const result = spawnSync("sh", ["-c", hooks.UserPromptSubmit], { encoding: "utf8", env: { ...hookEnv, AIFY_HERDR_AGENT: "" } });
  assert.equal(result.status, 0);
  assert.equal(reports().length, 1, "only the claim's own report should be there");
});

const MANAGED = (paneFile) => ({ AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_HERDR_PANE_FILE: paneFile });
const paneFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-codex-dot-pane-")), "pane");

test("A MANAGED CODEX WORKER reports to the pane aify-env names, and claims nothing", { skip: WIN }, () => {
  const file = paneFile();
  const { fire, reports } = launch({ env: MANAGED(file), args: ["--managed"] });
  assert.deepEqual(reports(), [], "a managed worker claimed a pane");
  fire("UserPromptSubmit");
  assert.deepEqual(reports(), [], "reported before aify-env had named a pane");
  fs.writeFileSync(file, "w2:p5\n");
  fire("UserPromptSubmit");
  fire("Stop");
  assert.deepEqual(reports(), [
    "pane report-agent w2:p5 --source herdr:aify --agent codex-aify --state working",
    "pane report-agent w2:p5 --source herdr:aify --agent codex-aify --state idle",
  ]);
});

test("A MANAGED RESUME gets no hooks until config.toml trusts them, because codex would stop to ask", { skip: WIN }, () => {
  const untrusted = launch({ env: MANAGED(paneFile()), args: ["--managed", "--resume", "thread-1"] });
  assert.deepEqual(untrusted.hooks, {});
  assert.match(untrusted.claimLog(), /codex hooks withheld/);

  const trusted = launch({
    env: MANAGED(paneFile()),
    args: ["--managed", "--resume", "thread-1"],
    codexConfig: (script) => CODEX_STATE_EVENTS.map(([, key, state]) =>
      `[hooks.state.${JSON.stringify(codexHookTrustKey(key))}]\ntrusted_hash = "${codexHookHash(key, codexStateCommand(script, state))}"\n`).join("\n"),
  });
  assert.deepEqual(Object.keys(trusted.hooks).sort(), ["Interrupt", "PermissionRequest", "PostToolUse", "Stop", "UserPromptSubmit"]);
});

// ── the trust check, against what codex itself wrote ─────────────────────────────────────────────
//
// Copied from the config.toml codex-cli 0.154.0 wrote when "Trust all and continue" was chosen on the
// review screen, for hooks whose state script sat at this path. A hash computed here that disagrees
// with these would withhold the hooks from every managed resume for good.
const OBSERVED_SCRIPT = "/tmp/tmp.3v9uRgYo2E/bridge/node_modules/aify-wrapper/bin/aify-herdr-state.sh";
const OBSERVED_CONFIG = `
[hooks.state."/<session-flags>/config.toml:permission_request:0:0"]
trusted_hash = "sha256:daa3cdcf16c648f24b5ee8182482ce1e1c994b2eba043c300f23bf9915f6e21c"

[hooks.state."/<session-flags>/config.toml:post_tool_use:0:0"]
trusted_hash = "sha256:0bdea8b74137cba93e849f1b01202596f081743921e98a0bcf760c4956cfca6a"

[hooks.state."/<session-flags>/config.toml:user_prompt_submit:0:0"]
trusted_hash = "sha256:09f233db276c4d6268aff22a2fda81fdc96eb16a1e0a3dbf4992756eadc74b0d"

[hooks.state."/<session-flags>/config.toml:stop:0:0"]
trusted_hash = "sha256:804734df8069f0443212767e405f4d5e39d6ff95ed27ac54a8aba0b60325233b"

[hooks.state."/<session-flags>/config.toml:interrupt:0:0"]
trusted_hash = "sha256:3a487c62ac8fa57ecde0702e8297d700483d8be167c875c6239c8c6723654897"
`;

test("the hash matches the one codex wrote for the same hook", () => {
  assert.equal(codexHookHash("stop", codexStateCommand(OBSERVED_SCRIPT, "idle")),
    "sha256:804734df8069f0443212767e405f4d5e39d6ff95ed27ac54a8aba0b60325233b");
  assert.equal(codexHooksTrusted(OBSERVED_CONFIG, OBSERVED_SCRIPT, { windows: false }), true);
});

test("the trust check says no to anything it cannot match", () => {
  assert.equal(codexHooksTrusted("", OBSERVED_SCRIPT, { windows: false }), false);
  // A moved bridge changes the command, so every stored hash is stale.
  assert.equal(codexHooksTrusted(OBSERVED_CONFIG, "/elsewhere/aify-herdr-state.sh", { windows: false }), false);
  // One event missing is not trusted: codex would still stop for that one.
  const withoutInterrupt = OBSERVED_CONFIG.slice(0, OBSERVED_CONFIG.indexOf("[hooks.state.\"/<session-flags>/config.toml:interrupt"));
  assert.equal(codexHooksTrusted(withoutInterrupt, OBSERVED_SCRIPT, { windows: false }), false);
  // A table with no hash of its own does not borrow the next table's, even one holding the right hash.
  const stopHash = "sha256:804734df8069f0443212767e405f4d5e39d6ff95ed27ac54a8aba0b60325233b";
  const hashless = OBSERVED_CONFIG.replace(`:stop:0:0"]\ntrusted_hash = "${stopHash}"\n`,
    `:stop:0:0"]\nenabled = true\n\n[hooks.state."/home/someone/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "${stopHash}"\n`);
  assert.notEqual(hashless, OBSERVED_CONFIG);
  assert.equal(codexHooksTrusted(hashless, OBSERVED_SCRIPT, { windows: false }), false);
  // Windows files the same hooks under a different synthetic path.
  assert.equal(codexHooksTrusted(OBSERVED_CONFIG, OBSERVED_SCRIPT, { windows: true }), false);
});

test("the -c values are the commands the trust check hashes, and report under the claim's source", () => {
  const args = codexHookArgs(OBSERVED_SCRIPT);
  assert.equal(args.length, CODEX_STATE_EVENTS.length * 2);
  assert.ok(args.includes(`hooks.Stop=[{hooks=[{type="command",command=${JSON.stringify(codexStateCommand(OBSERVED_SCRIPT, "idle"))},timeout=3}]}]`));
  const script = fs.readFileSync(path.join(ROOT, "bin", "aify-herdr-state.sh"), "utf8");
  assert.ok(script.includes(`--source ${AIFY_AGENT_SOURCE} `));
});
