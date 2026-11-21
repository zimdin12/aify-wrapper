// Real install, render and launch. The runtime and possible own-service programs are only recorders.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rerenderLaunchers, recordDirFor } from "../lib/launcher-rerender.mjs";
import { readRecords } from "../lib/render-record.mjs";
import { ownerEnv, writePrivateCredential } from "./private-credential.mjs";
import { sealedPath } from "./sealed-path.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMS = "http://127.0.0.2:1";
const DASH = "http://127.0.0.3:1";
const KEY = "fixture-dashboard-key";
const AGENT = "fixture-claude";
const posix = (p) => p.split(path.sep).join("/");

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-no-own-"));
  const dest = path.join(home, "bin");
  const registry = path.join(home, ".aify", "services.json");
  const bridge = path.join(home, ".aify-comms", "mcp", "stdio");
  const seen = path.join(home, "seen");
  for (const dir of [bridge, seen, path.dirname(registry)]) fs.mkdirSync(dir, { recursive: true });
  const { PATH, stubs } = sealedPath(["claude", "aify-env"]);
  fs.writeFileSync(path.join(stubs, "claude"), [
    '#!/bin/bash', 'set -eu', 'env > "$SEEN/env"', 'printf "%s\n" "$@" > "$SEEN/args"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --settings) cp "$2" "$SEEN/hooks.json"; shift ;;',
    '    --mcp-config) cp "$2" "$SEEN/strict.json"; shift ;;',
    '    --mcp-config=*) cp "${1#--mcp-config=}" "$SEEN/session.json" ;;',
    '  esac', '  shift', 'done', '',
  ].join("\n"));
  fs.writeFileSync(path.join(stubs, "aify-env"), '#!/bin/sh\nprintf "%s\n" "$@" >> "$SEEN/host"\nexit 99\n');
  for (const name of ["claude", "aify-env"]) fs.chmodSync(path.join(stubs, name), 0o755);
  for (const file of ["server.js", "claude-channel.js", "claude-session-hook.js", "agent-state-event.mjs", "session-for-agent.mjs",
    "agent-for-handle.mjs", "reap-managed-claude.js"]) {
    fs.writeFileSync(path.join(bridge, file), `import('node:fs').then(fs => fs.appendFileSync(process.env.SEEN + '/bridge', ${JSON.stringify(`${file}\n`)}));\n`);
  }
  const env = { ...ownerEnv(), PATH, SEEN: posix(seen), HOME: posix(home), USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TMPDIR: posix(home), TEMP: home, TMP: home, HARNESS_IDENTITY: AGENT, AIFY_MACHINE_ID: "fixture-host",
    AIFY_SERVICE_REGISTRY: registry, CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
  const run = (file, args, patch = {}) => spawnSync("bash", [file, ...args], { cwd: home, env: { ...env, ...patch }, encoding: "utf8" });
  const install = (...args) => run(path.join(ROOT, "install.sh"), ["--dest", dest, "--registry", registry, ...args]);
  const launch = (args = [], patch = {}) => run(path.join(dest, "claude-aify"), ["--safe", ...args], patch);
  const content = (name) => fs.existsSync(path.join(seen, name)) ? fs.readFileSync(path.join(seen, name), "utf8") : "";
  return { home, dest, registry, bridge, env, install, launch, content };
}

const dashboard = (endpoint = DASH) => ({ endpoint, mcpTransport: "http", sessionInject: { mcp: true }, credentialRef: "dashboard.key" });
const put = (w, services) => fs.writeFileSync(w.registry, JSON.stringify({ version: 1, services }));
const OK = (run) => assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
const noOwn = ["--client", "claude", "--no-own-service"];
const named = ["--client", "claude", "--service", "aify-comms", "--endpoint", COMMS];
const leaked = { AIFY_COMMS_URL: COMMS, HARNESS_ENDPOINT: COMMS, AIFY_CHANNELS_ENABLED: "1", AIFY_CHANNEL_ROUTE: "dev", AIFY_COMMS_MCP: "http" };

function onlyDashboard(w, endpoint) {
  const { mcpServers } = JSON.parse(w.content("session.json"));
  assert.deepEqual(Object.keys(mcpServers), ["aify-dashboard"], "no registry service was promoted to coordinating service");
  assert.equal(mcpServers["aify-dashboard"].type, "http");
  assert.equal(mcpServers["aify-dashboard"].url, `${endpoint}/mcp/http`);
  assert.equal(mcpServers["aify-dashboard"].headers["X-API-Key"], KEY);
  assert.equal(mcpServers["aify-dashboard"].headers["X-Aify-Agent-Id"], AGENT);
  const hooks = w.content("hooks.json");
  assert.ok(JSON.parse(hooks).hooks.SessionStart, "control: neutral hooks reached the runtime");
  assert.match(hooks, /aify-turn-start\.mjs/);
  assert.doesNotMatch(hooks, /claude-session-hook|agent-state-event|\.aify-comms/, "registry-only Claude must not configure own-service hooks");
  assert.doesNotMatch(w.content("args"), /--channels|--dangerously-load-development-channels|--strict-mcp-config/);
  assert.doesNotMatch(w.content("env"), /^(?:AIFY_COMMS_URL|AIFY_CHANNELS_ENABLED|AIFY_CHANNEL_ROUTE|AIFY_COMMS_MCP)=/m);
  assert.equal(w.content("strict.json"), "");
  assert.equal(w.content("bridge"), "", "the wrapper must not start an own-service program");
  assert.equal(w.content("host"), "", "the wrapper must not hand off to a host");
}

test("an explicit no-own Claude install and re-render add only the registry's dashboard tools", () => {
  const w = world();
  writePrivateCredential(w.home, "dashboard.key", KEY);
  put(w, { "aify-dashboard": dashboard() });
  OK(w.install(...noOwn));
  assert.ok(readRecords(recordDirFor(w.registry))[0].pairs.includes("SERVICE_NAME="), "the record must distinguish explicit empty from missing");
  const checked = w.launch(["--check"], leaked);
  OK(checked);
  assert.match(checked.stdout, /endpoint +: <no own service>/);
  assert.equal(w.content("args"), "", "checking a registry-only launcher must not start Claude");
  OK(w.launch([], leaked));
  onlyDashboard(w, DASH);

  // A later connection cannot turn this launcher into a comms-owned one.
  const moved = "http://127.0.0.4:1";
  put(w, { "aify-comms": { endpoint: COMMS, mcpTransport: "http" }, "aify-dashboard": dashboard(moved) });
  const rows = rerenderLaunchers({ dest: w.dest, registryPath: w.registry, wrapperRoot: ROOT, env: w.env });
  assert.deepEqual(rows.map((row) => row.state), ["re-rendered"], JSON.stringify(rows));
  OK(w.launch([], leaked));
  onlyDashboard(w, moved);
});

test("explicit legacy comms still contributes its bridge, channel, endpoint and hooks and refuses a missing channel", () => {
  const w = world();
  put(w, { "aify-comms": { endpoint: COMMS } });
  OK(w.install(...named));
  const moved = "http://127.0.0.2:2";
  OK(w.launch([], { AIFY_COMMS_URL: moved, AIFY_CLAUDE_STRICT_MCP: "1" }));
  const strict = JSON.parse(w.content("strict.json")).mcpServers;
  assert.deepEqual(Object.keys(strict), ["aify-comms", "aify-comms-channel"]);
  assert.equal(strict["aify-comms"].env.AIFY_SERVER_URL, moved);
  assert.match(strict["aify-comms"].args[0], /\/server\.js$/);
  assert.match(strict["aify-comms-channel"].args[0], /\/claude-channel\.js$/);
  assert.match(w.content("args"), /server:aify-comms-channel/);
  const hooks = JSON.parse(w.content("hooks.json")).hooks.SessionStart[0].hooks;
  assert.match(hooks[0].command, /claude-session-hook\.js/);
  assert.match(hooks[1].command, /agent-state-event\.mjs/);
  assert.match(hooks.at(-1).command, /aify-turn-start\.mjs/);
  assert.equal(w.content("bridge"), "agent-state-event.mjs\n", "control: the exit path started an actual bridge program");

  const broken = world();
  put(broken, { "aify-comms": { endpoint: COMMS } });
  OK(broken.install(...named, "--bridge-dir", path.join(broken.home, "missing")));
  const refused = broken.launch([], { AIFY_CLAUDE_STRICT_MCP: "1" });
  assert.equal(refused.status, 78, "an explicitly selected comms launcher must refuse a missing channel");
  assert.match(refused.stderr, /would start with no channel/);
  assert.equal(broken.content("args"), "", "the broken own-service launch must not reach Claude");
});

test("a current render record missing SERVICE_NAME refuses rather than selecting no own service", () => {
  const w = world();
  put(w, { "aify-comms": { endpoint: COMMS } });
  OK(w.install(...named));
  const reRender = () => rerenderLaunchers({ dest: w.dest, registryPath: w.registry, wrapperRoot: ROOT, env: w.env });
  assert.deepEqual(reRender().map((row) => row.state), ["re-rendered"], "control: the intact record is current and can re-render");

  const dir = recordDirFor(w.registry);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const file = path.join(dir, files[0]);
  const fields = fs.readFileSync(file, "utf8").split("\0");
  assert.deepEqual(fields.filter((pair) => pair.startsWith("SERVICE_NAME=")), ["SERVICE_NAME=aify-comms"]);
  fs.writeFileSync(file, fields.filter((pair) => !pair.startsWith("SERVICE_NAME=")).join("\0"));
  const launcher = path.join(w.dest, "claude-aify");
  const before = fs.readFileSync(launcher);
  const rows = reRender();
  assert.deepEqual(rows.map((row) => row.state), ["failed"], "a missing SERVICE_NAME must not re-render as no own service");
  assert.match(rows[0].detail, /unsubstituted placeholders: @@SERVICE_NAME@@/);
  assert.deepEqual(fs.readFileSync(launcher), before, "a refused re-render keeps the installed launcher byte for byte");
});

test("registry-only mode refuses ambiguous install inputs and own-service launch switches", () => {
  const w = world();
  put(w, { "aify-dashboard": dashboard() });
  const implicit = w.install("--client", "claude");
  assert.equal(implicit.status, 78);
  assert.match(implicit.stderr, /--endpoint is required/);
  for (const args of [[...noOwn, "--service", "aify-comms"], [...noOwn, "--endpoint", COMMS], ["--client", "codex", "--no-own-service"]]) {
    const refused = w.install(...args);
    assert.equal(refused.status, 78, "ambiguous own-service selection must refuse");
    assert.match(refused.stderr, /--no-own-service requires --client claude and takes no own-service options/);
    assert.equal(fs.existsSync(w.dest), false, "invalid flags must not write a launcher");
  }
  OK(w.install(...noOwn));
  for (const [args, patch] of [[["--shared"], {}], [[], { AIFY_CLAUDE_STRICT_MCP: "1" }], [[], { HARNESS_MCP_COMMAND: "node own.js" }]]) {
    const refused = w.launch(args, patch);
    assert.equal(refused.status, 78, refused.stderr);
    assert.match(refused.stderr, /require an own service/);
    assert.equal(w.content("args"), "");
    assert.equal(w.content("host"), "");
    assert.equal(w.content("bridge"), "");
  }
});
