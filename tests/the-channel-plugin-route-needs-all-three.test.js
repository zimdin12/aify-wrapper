#!/usr/bin/env node
// claude-aify takes the aify-channel plugin route only when the policy admits it, it is installed and
// enabled, and ~/.claude.json no longer starts the development route's server. Anything less keeps the
// development channel, which works without any of it.
//
// Each miss has its own cost: without the policy Claude drops the plugin's events and the agent never
// wakes; without the plugin there is no channel at all; with the legacy server still present two channel
// copies share one agent's bridge id and race for its runs.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { withOurChannel } from "../lib/channel-policy.mjs";
import { decideRoute, LEGACY_SERVER, PLUGIN_ID, routeHere } from "../lib/channel-route.mjs";

const ADMITS = withOurChannel("").text;
const INSTALLED = JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "x" }] } });
const ALL = { policyText: ADMITS, installedText: INSTALLED, settingsText: "{}", claudeJsonText: JSON.stringify({ mcpServers: {} }) };

test("all three hold: the plugin route", () => {
  assert.deepEqual(decideRoute(ALL), { route: "plugin", reason: "" });
  assert.equal(PLUGIN_ID, "aify-channel@aify-local");
});

for (const [name, change, said] of [
  ["no policy", { policyText: null }, /policy/],
  ["a policy without our entry", { policyText: JSON.stringify({ allowedChannelPlugins: [] }) }, /policy/],
  ["a malformed policy", { policyText: "{" }, /policy/],
  ["not installed", { installedText: null }, /not installed/],
  ["installed list empty", { installedText: JSON.stringify({ plugins: { [PLUGIN_ID]: [] } }) }, /not installed/],
  ["disabled", { settingsText: JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }) }, /disabled/],
  ["the legacy server still in ~/.claude.json", { claudeJsonText: JSON.stringify({ mcpServers: { [LEGACY_SERVER]: { command: "node" } } }) }, /second copy/],
]) {
  test(`${name}: the development route, saying why`, () => {
    const decision = decideRoute({ ...ALL, ...change });
    assert.equal(decision.route, "dev");
    assert.match(decision.reason, said);
  });
}

test("on the machine, the route reads the policy and the three files under HOME", () => {
  const home = path.join("H:", "home");
  const files = {
    [path.join(home, ".claude", "plugins", "installed_plugins.json")]: INSTALLED,
    [path.join(home, ".claude.json")]: "{}",
  };
  const readFile = (file) => { if (file in files) return files[file]; throw new Error(`ENOENT ${file}`); };
  const policy = (text) => (source) => (source.admin ? null : text);
  assert.equal(routeHere({ platform: "win32", home, read: policy(ADMITS), readFile }).route, "plugin");
  assert.equal(routeHere({ platform: "win32", home, read: policy(null), readFile }).route, "dev");
  assert.equal(routeHere({ platform: "win32", home, read: policy(ADMITS), readFile: () => { throw new Error("ENOENT"); } }).route, "dev");
});
