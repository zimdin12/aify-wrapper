#!/usr/bin/env node
// claude-aify starts the aify channel as a plugin, with no development-channels prompt, when every channel server the
// session runs is ready for it (lib/channel-route.mjs); as today's development channel when its server is configured;
// and refuses to start deaf when neither is. It exports AIFY_CHANNEL_ROUTE on every route, because each configured
// channel server reads it to decide whether it claims messages.
//
// A REAL rendered launcher run to a stub claude. The run's wrapper directory gets this package's route modules, its
// bridge gets channel scripts that declare the producer gate (or not), and its HOME gets Claude's files. The plugin
// route needs the managed policy, which on Windows is the per-user registry value: a `reg.cmd` stub on the run's PATH
// answers for it (the run's PATH holds no System32, so the real reg.exe is out of reach). Elsewhere the policy is an
// admin file outside HOME, so the plugin route's launcher runs are Windows-only; the decision itself is covered on
// every platform by the-channel-route-reads-every-channel-the-session-runs.test.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { withOurChannel } from "../lib/channel-policy.mjs";
import { PLUGIN_ID } from "../lib/channel-route.mjs";
import { launch } from "./launch-to-a-stub-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const ONLY_WINDOWS = !WIN && "the managed policy is an admin file outside HOME here";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

/** This package's route modules, placed in the run's wrapper directory. */
const ROUTE_MODULES = Object.fromEntries(["channel-route-cli.mjs", "channel-route.mjs", "channel-policy.mjs", "main-module.mjs"]
  .map((name) => [`wrapper/lib/${name}`, fs.readFileSync(path.join(ROOT, "lib", name), "utf8")]));

/**
 * A reg.cmd that answers `reg export` of the per-user policy key with `policy` (a .reg file, ASCII, as the reader
 * accepts it without a BOM) and finds nothing else. `policy` must hold no cmd metacharacter.
 */
const regStub = (policy) => [
  "@echo off",
  `if /I "%1"=="export" if /I %2=="HKCU\\SOFTWARE\\Policies\\ClaudeCode" (`,
  "  > %3 echo Windows Registry Editor Version 5.00",
  "  >> %3 echo.",
  "  >> %3 echo [HKEY_CURRENT_USER\\SOFTWARE\\Policies\\ClaudeCode]",
  `  >> %3 echo "Settings"="${policy.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`,
  "  exit /b 0",
  ")",
  "echo ERROR: The system was unable to find the specified registry key or value. 1>&2",
  "exit /b 1",
  "",
].join("\r\n");

const GATED = "export const CHANNEL_PRODUCER_GATE = 1;\n";
const GATED_BRIDGE = { "bridge/claude-channel.js": GATED, "bridge/claude-channel-plugin.mjs": 'import { runChannel } from "./claude-channel.js";\n' };
/** ~/.claude.json with the user-scope channel server the development route loads, running `script` in the bridge. */
const userScopeServer = (script = "claude-channel.js") => ({
  "<home>/.claude.json": ({ bridge }) => JSON.stringify({ mcpServers: { "aify-comms-channel": { command: "node", args: [path.join(bridge, script)] } } }),
});
const PLUGIN_INSTALLED = {
  "stubs/reg.cmd": regStub(withOurChannel("").text),
  "<home>/.claude/plugins/installed_plugins.json": ({ home }) =>
    JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: path.join(home, "cache", "aify-channel") }] } }),
  "<home>/cache/aify-channel/.claude-plugin/plugin.json": ({ bridge }) =>
    JSON.stringify({ name: "aify-channel", mcpServers: { "aify-comms-channel": { command: "node", args: [path.join(bridge, "claude-channel-plugin.mjs")] } } }),
};
const READY = { ...ROUTE_MODULES, ...GATED_BRIDGE, ...userScopeServer(), ...PLUGIN_INSTALLED };

/** Launch, keeping a copy of the strict MCP config when there is one. */
function run(files, { args = ["--safe", "do x"], env = {} } = {}) {
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), "aify-channel-route-"));
  const copy = path.join(keep, "mcp.json");
  const result = launch("claude", args, {
    files,
    env: { ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}), ...env },
    edit: (text) => text.replace("  # Strict mode (AIFY_CLAUDE_STRICT_MCP=1): only the config above is visible",
      `  cp "$AIFY_MCP_CONFIG" "${posix(copy)}"\n  # Strict mode (AIFY_CLAUDE_STRICT_MCP=1): only the config above is visible`),
  });
  const config = fs.existsSync(copy) ? JSON.parse(fs.readFileSync(copy, "utf8")) : null;
  fs.rmSync(keep, { recursive: true, force: true });
  return { ...result, config };
}

const DEV = ["--dangerously-load-development-channels", "server:aify-comms-channel"];
const PLUGIN = ["--channels", "plugin:aify-channel@aify-local"];

test("the development server configured, no plugin: the development channel, and the route exported", () => {
  const { run: r, args, started } = run({ ...ROUTE_MODULES, ...GATED_BRIDGE, ...userScopeServer() });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(args.slice(0, 2), DEV);
  assert.match(args[2], /^--/, "a flag follows the channel's one value");
  assert.equal(started.AIFY_CHANNEL_ROUTE, "dev");
});

test("no channel server configured and no plugin: refused with the repair, and Claude never starts", () => {
  const { run: r, args } = run(ROUTE_MODULES);
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /would start with no channel: no aify-comms-channel server is configured/);
  assert.match(r.stderr, /Re-run the service's installer/);
  assert.deepEqual(args, [], "claude was started");
});

test("ready: --channels with the plugin, the route and the endpoint exported for its server", { skip: ONLY_WINDOWS }, () => {
  const { run: r, args, started } = run(READY);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(args.slice(0, 2), PLUGIN, args.join(" "));
  assert.match(args[2], /^--/, "a flag follows the channel's one value");
  assert.ok(!args.includes("--dangerously-load-development-channels"), args.join(" "));
  assert.equal(started.AIFY_CHANNEL_ROUTE, "plugin");
  assert.equal(started.AIFY_SERVER_URL, "http://127.0.0.2:1");
  assert.equal(started.CLAUDE_MCP_SERVER_URL, "http://127.0.0.2:1");
});

for (const [name, files, opts] of [
  ["the user-scope server runs a channel that predates the gate", { ...READY, "bridge/old-channel/claude-channel.js": "// old\n", ...userScopeServer("old-channel/claude-channel.js") }, {}],
  ["strict mode, which supplies its own channel server", READY, { env: { AIFY_CLAUDE_STRICT_MCP: "1" } }],
  ["the arguments bring their own MCP config", READY, { args: ["--safe", "--mcp-config=/x.json", "do x"] }],
]) {
  test(`ready, but ${name}: the development channel`, { skip: ONLY_WINDOWS }, () => {
    const { run: r, args, started, config } = run(files, opts);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(args.slice(0, 2), DEV, args.join(" "));
    assert.equal(started.AIFY_CHANNEL_ROUTE, "dev");
    if (opts.env?.AIFY_CLAUDE_STRICT_MCP) assert.ok(config?.mcpServers?.["aify-comms-channel"], "strict mode lost its channel server");
  });
}
