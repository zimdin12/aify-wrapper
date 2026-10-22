#!/usr/bin/env node
// claude-aify starts the aify channel as a plugin, with no development-channels prompt, when the host is
// ready for it (lib/channel-route.mjs), and as today's development channel otherwise.
//
// A REAL rendered launcher run to a stub claude. The plugin route needs the managed policy, which on
// Windows is the per-user registry value: a `reg.cmd` stub on the run's PATH answers for it (the run's PATH
// holds no System32, so the real reg.exe is out of reach), and the launcher's wrapper directory gets this
// package's route modules. Elsewhere the policy is an admin file outside HOME, so the plugin route's
// launcher run is Windows-only; its decision is covered on every platform by
// the-channel-plugin-route-needs-all-three.test.js.

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
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

/** This package's route modules, placed in the run's wrapper directory. */
const ROUTE_MODULES = Object.fromEntries(["channel-route-cli.mjs", "channel-route.mjs", "channel-policy.mjs"]
  .map((name) => [`wrapper/lib/${name}`, fs.readFileSync(path.join(ROOT, "lib", name), "utf8")]));

/** A reg.cmd that answers the per-user policy query with `policy` and finds nothing else. */
const regStub = (policy) => [
  "@echo off",
  `if /I %2=="HKCU\\SOFTWARE\\Policies\\ClaudeCode" (`,
  "  echo.",
  `  echo     Settings    REG_SZ    ${policy}`,
  "  exit /b 0",
  ")",
  "exit /b 1",
  "",
].join("\r\n");

const INSTALLED = JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user" }] } });

/** Launch in strict mode, keeping a copy of the MCP config Claude was handed. */
function launchStrict(files) {
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), "aify-channel-route-"));
  const copy = path.join(keep, "mcp.json");
  const result = launch("claude", ["--safe", "do x"], {
    files,
    env: { AIFY_CLAUDE_STRICT_MCP: "1", ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}) },
    edit: (text) => text.replace("  # Strict mode (AIFY_CLAUDE_STRICT_MCP=1): only the config above is visible",
      `  cp "$AIFY_MCP_CONFIG" "${posix(copy)}"\n  # Strict mode (AIFY_CLAUDE_STRICT_MCP=1): only the config above is visible`),
  });
  const config = fs.existsSync(copy) ? JSON.parse(fs.readFileSync(copy, "utf8")) : null;
  fs.rmSync(keep, { recursive: true, force: true });
  return { ...result, config };
}

const READY = {
  ...ROUTE_MODULES,
  "stubs/reg.cmd": regStub(withOurChannel("").text),
  "<home>/.claude/plugins/installed_plugins.json": INSTALLED,
};

test("a host not ready for the plugin: the development channel, its server in the strict config", () => {
  const { run, args, config } = launchStrict(ROUTE_MODULES);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(args.slice(0, 2), ["--dangerously-load-development-channels", "server:aify-comms-channel"]);
  assert.match(args[2], /^--/, "a flag follows the channel's one value");
  assert.ok(config, "the strict config was not captured");
  assert.ok(config.mcpServers["aify-comms-channel"], JSON.stringify(config));
});

test("ready: --channels with the plugin, no development flag, no second channel server", { skip: !WIN && "the managed policy is an admin file outside HOME here" }, () => {
  const { run, args, started, config } = launchStrict(READY);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(args.slice(0, 2), ["--channels", "plugin:aify-channel@aify-local"], args.join(" "));
  assert.match(args[2], /^--/, "a flag follows the channel's one value");
  assert.ok(!args.includes("--dangerously-load-development-channels"), args.join(" "));
  assert.ok(config, "the strict config was not captured");
  assert.equal(config.mcpServers["aify-comms-channel"], undefined, JSON.stringify(config));
  assert.ok(config.mcpServers["aify-comms"], "the comms bridge is still there");
  // The plugin's channel finds comms' channel and endpoint through these.
  assert.ok(started.AIFY_BRIDGE_DIR, "AIFY_BRIDGE_DIR was not exported");
  assert.equal(started.AIFY_SERVER_URL, "http://127.0.0.2:1");
  assert.equal(started.CLAUDE_MCP_SERVER_URL, "http://127.0.0.2:1");
});

test("ready, but ~/.claude.json still starts the development route's server: the development channel", { skip: !WIN && "as above" }, () => {
  const { run, args } = launchStrict({ ...READY, "<home>/.claude.json": JSON.stringify({ mcpServers: { "aify-comms-channel": { command: "node" } } }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(args[0], "--dangerously-load-development-channels", args.join(" "));
});
