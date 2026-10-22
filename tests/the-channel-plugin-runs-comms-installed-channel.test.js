#!/usr/bin/env node
// The aify-channel plugin runs aify-comms' installed claude-channel.js with the endpoint claude-aify gave
// it, else comms' registry entry. A channel it cannot find, or no endpoint, is refused with the reason.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { channelLaunch } from "../plugins/aify-local/plugins/aify-channel/channel-launch.mjs";

const home = path.join("H:", "home");
const everywhere = () => true;
const registry = JSON.stringify({ services: { "aify-comms": { endpoint: "http://reg:8800" } } });

test("the launcher's bridge and endpoint win", () => {
  const plan = channelLaunch({ env: { AIFY_BRIDGE_DIR: "/b", AIFY_SERVER_URL: "http://env:1", X: "kept" }, home, exists: everywhere, registryText: registry });
  assert.equal(plan.ok, true);
  assert.equal(plan.script, path.join("/b", "claude-channel.js"));
  assert.equal(plan.env.CLAUDE_MCP_SERVER_URL, "http://env:1");
  assert.equal(plan.env.AIFY_SERVER_URL, "http://env:1");
  assert.equal(plan.env.X, "kept");
});

test("outside claude-aify: comms' default bridge directory and its registry endpoint", () => {
  const plan = channelLaunch({ env: {}, home, exists: everywhere, registryText: registry });
  assert.equal(plan.script, path.join(home, ".aify-comms", "mcp", "stdio", "claude-channel.js"));
  assert.equal(plan.env.AIFY_SERVER_URL, "http://reg:8800");
  assert.equal(channelLaunch({ env: { AIFY_HOME: "/a" }, home, exists: everywhere, registryText: registry }).script,
    path.join("/a", "mcp", "stdio", "claude-channel.js"));
});

test("no channel installed, or no endpoint anywhere: refused with the reason", () => {
  assert.match(channelLaunch({ env: {}, home, exists: () => false, registryText: registry }).reason, /not installed/);
  for (const text of [null, "", "{", JSON.stringify({ services: {} })]) {
    const plan = channelLaunch({ env: {}, home, exists: everywhere, registryText: text });
    assert.equal(plan.ok, false, String(text));
    assert.match(plan.reason, /no aify-comms endpoint/);
  }
});
