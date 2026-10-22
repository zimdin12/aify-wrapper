#!/usr/bin/env node
// Installing the channel plugin checks the bridge declares the producer gate, merges the policy and reads it back,
// renders the plugin for that bridge, installs it, and reads the route back. It removes no MCP server: the user-scope
// aify-comms-channel server is the development route, and each server decides for itself whether it claims. A step
// that fails stops the install.
//
// Every collaborator is a recording fake: no test writes the registry, Claude's files or runs the real claude.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { bridgeDirArg, installChannel, removeChannel } from "../lib/channel-install.mjs";
import { OUR_ENTRY, withOurChannel } from "../lib/channel-policy.mjs";
import { marketplaceDir, renderMarketplace } from "../lib/channel-plugin.mjs";
import { CHANNEL_SERVER, PLUGIN_ENTRY, USER_SCOPE_ENTRY } from "../lib/channel-route.mjs";

const HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
const BRIDGE = path.join("/b", "mcp", "stdio");
const GATED = "export const CHANNEL_PRODUCER_GATE = 1;";
const ENTRY = 'import { runChannel } from "./claude-channel.js";';

/** A fake machine. */
function machine({ policy = null, admin = null, writes = true, failing = [], route = "plugin", scripts } = {}) {
  const state = { policy, calls: [], rendered: null };
  const gated = scripts ?? { [path.join(BRIDGE, PLUGIN_ENTRY)]: ENTRY, [path.join(BRIDGE, USER_SCOPE_ENTRY)]: GATED };
  return {
    state,
    bridgeDir: BRIDGE,
    platform: "win32",
    home: "/h",
    read: (source) => (source.admin ? admin : state.policy),
    write: (key, text) => { state.calls.push(`write ${key}`); if (writes) state.policy = text; return { ok: true }; },
    remove: (key) => { state.calls.push(`delete ${key}`); state.policy = null; return { ok: true }; },
    readScript: (file) => gated[file] ?? null,
    writeFiles: (dir, files) => { state.calls.push(`render ${dir}`); state.rendered = { dir, files }; },
    claude: (args) => { state.calls.push(`claude ${args.join(" ")}`); return { ok: !failing.some((f) => args.join(" ").startsWith(f)), out: "x" }; },
    route: () => ({ route, reason: route === "plugin" ? "" : "a reason" }),
  };
}

test("the rendered plugin runs the bridge's gated entry straight from node, under the channel's server key", () => {
  const files = renderMarketplace(BRIDGE);
  const plugin = JSON.parse(files[path.join("plugins", OUR_ENTRY.plugin, ".claude-plugin", "plugin.json")]);
  assert.deepEqual(plugin.mcpServers, { [CHANNEL_SERVER]: { command: "node", args: [path.join(BRIDGE, PLUGIN_ENTRY)] } });
  const market = JSON.parse(files[path.join(".claude-plugin", "marketplace.json")]);
  assert.equal(market.name, OUR_ENTRY.marketplace);
  assert.deepEqual(market.plugins.map((p) => p.name), [OUR_ENTRY.plugin]);
  assert.equal(marketplaceDir("/h"), path.join("/h", ".aify", "claude-plugins", "aify-local"));
});

test("install: bridge, policy, render, a fresh install, the route read back; no MCP server removed", () => {
  const m = machine({ policy: JSON.stringify({ model: "opus" }) });
  const result = installChannel(m);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(m.state.calls, [
    `write ${HKCU}`,
    `render ${marketplaceDir("/h")}`,
    "claude plugin uninstall aify-channel@aify-local",
    "claude plugin marketplace remove aify-local",
    `claude plugin marketplace add ${marketplaceDir("/h")}`,
    "claude plugin install aify-channel@aify-local",
  ]);
  assert.equal(JSON.parse(m.state.policy).model, "opus", "the operator's policy is kept");
  assert.ok(!m.state.calls.some((c) => c.includes("mcp")), "an MCP server was touched");
});

for (const [name, setup, said] of [
  ["no bridge named", { bridgeDir: undefined }, /--bridge-dir is required/],
  ["a bridge without the plugin entry", { scripts: { [path.join(BRIDGE, USER_SCOPE_ENTRY)]: GATED } }, /claude-channel-plugin\.mjs is missing/],
  ["a bridge whose channel predates the gate", { scripts: { [path.join(BRIDGE, PLUGIN_ENTRY)]: ENTRY } }, /claude-channel\.js does not declare/],
  ["an admin policy that does not admit", { admin: JSON.stringify({ model: "x" }) }, /admin policy/],
  ["a write that does not read back", { writes: false }, /read back/],
  ["the marketplace add failing", { failing: ["plugin marketplace add"] }, /marketplace add/],
  ["the plugin install failing", { failing: ["plugin install"] }, /plugin install/],
  ["installed but the route reads otherwise", { route: "dev" }, /route here is dev/],
]) {
  test(`${name}: stops, saying why`, () => {
    const m = machine(setup);
    const result = installChannel({ ...m, ...("bridgeDir" in setup ? { bridgeDir: setup.bridgeDir } : {}) });
    assert.equal(result.ok, false);
    assert.match(result.reason, said);
  });
}

test("nothing is written before the bridge is known to be gated", () => {
  const m = machine({ scripts: {} });
  installChannel(m);
  assert.deepEqual(m.state.calls, []);
});

test("a policy that already admits is not rewritten", () => {
  const m = machine({ policy: withOurChannel("").text });
  assert.equal(installChannel(m).ok, true);
  assert.ok(!m.state.calls.some((c) => c.startsWith("write")), m.state.calls.join("\n"));
});

test("remove: plugin, marketplace, and only our policy entry", () => {
  const shared = machine({ policy: JSON.stringify({ model: "opus", allowedChannelPlugins: [OUR_ENTRY] }) });
  assert.equal(removeChannel(shared).ok, true);
  assert.deepEqual(JSON.parse(shared.state.policy), { model: "opus" });
  assert.deepEqual(shared.state.calls.slice(0, 2), ["claude plugin uninstall aify-channel@aify-local", "claude plugin marketplace remove aify-local"]);
  const ours = machine({ policy: withOurChannel("").text });
  assert.equal(removeChannel(ours).ok, true);
  assert.ok(ours.state.calls.includes(`delete ${HKCU}`), ours.state.calls.join("\n"));
  const malformed = machine({ policy: "{" });
  assert.equal(removeChannel(malformed).ok, false);
  assert.equal(malformed.state.policy, "{");
});

test("--bridge-dir is read in both spellings", () => {
  assert.equal(bridgeDirArg(["--bridge-dir", "/x"]), "/x");
  assert.equal(bridgeDirArg(["--bridge-dir=/y"]), "/y");
  assert.equal(bridgeDirArg([]), undefined);
});
