#!/usr/bin/env node
// claude-aify takes the plugin route only when every channel server the session would run declares aify-comms'
// producer gate; else the development route when its server is configured; else `none`, which the launcher refuses.
//
// Both configured servers start in every session and each decides from AIFY_CHANNEL_ROUTE whether it claims
// (aify-comms mcp/stdio/channel-producer.mjs). A server that predates the gate claims on every route; on the plugin
// route its events are dropped and its claims lost. So the decision reads what each server RUNS: the plugin's entry,
// that bridge's claude-channel.js, and the script of every channel server in each scope. Old, new and partial bridges
// are built here as files, and nothing is run.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { withOurChannel } from "../lib/channel-policy.mjs";
import { CHANNEL_SERVER, channelServers, claudeConfigPaths, configuredChannels, declaredGate, decideRoute, gateOf, PLUGIN_ENTRY,
  PLUGIN_ID, pluginBlocker, routeHere, samePath, SUPPORTED_GATE, USER_SCOPE_ENTRY } from "../lib/channel-route.mjs";
import { namesItsOwnChannels, routeFor } from "../lib/channel-route-cli.mjs";

const GATED = "export const CHANNEL_PRODUCER_GATE = 1;\n";
/** aify-comms' plugin entry declares nothing itself: it runs claude-channel.js's runChannel(). */
const ENTRY = 'import { runChannel } from "./claude-channel.js";\n';
const BRIDGE = path.join("/b", "mcp", "stdio");
const OLD_BRIDGE = path.join("/old", "mcp", "stdio");
const entry = (dir, file) => path.join(dir, file);
const NEW = { [entry(BRIDGE, PLUGIN_ENTRY)]: ENTRY, [entry(BRIDGE, USER_SCOPE_ENTRY)]: `x\n${GATED}` };
const OLD = { [entry(OLD_BRIDGE, USER_SCOPE_ENTRY)]: "// no gate\n" };
const reader = (files) => (file) => files[file] ?? null;
const servers = (script) => JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [script] }, other: { command: "x" } } });
const user = (text) => ({ scope: "user", text, servers: (p) => p.mcpServers });

/** A host ready for the plugin route: every fact satisfied, then each test breaks one. */
const ready = (over = {}) => ({
  platform: "linux",
  bridgeDir: BRIDGE,
  policyText: withOurChannel("").text,
  installedText: JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "/cache" }] } }),
  settingsText: "{}",
  manifestText: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [entry(BRIDGE, PLUGIN_ENTRY)] } } }),
  readScript: reader({ ...NEW, ...OLD }),
  configs: [user(servers(entry(BRIDGE, USER_SCOPE_ENTRY)))],
  ...over,
});

test("the declaration is read as a version, and only the supported one passes", () => {
  assert.equal(declaredGate(GATED), 1);
  assert.equal(declaredGate("export const CHANNEL_PRODUCER_GATE = 2;"), 2);
  assert.equal(declaredGate("// export const CHANNEL_PRODUCER_GATE = 1;"), null);
  assert.equal(declaredGate(null), null);
  // The plugin's entry runs the gate declared beside it, and none at all when it is missing.
  assert.equal(gateOf(entry(BRIDGE, PLUGIN_ENTRY), reader(NEW)), 1);
  assert.equal(gateOf(entry(OLD_BRIDGE, PLUGIN_ENTRY), reader({ ...OLD, [entry(OLD_BRIDGE, PLUGIN_ENTRY)]: ENTRY })), null);
  assert.equal(gateOf(entry(BRIDGE, PLUGIN_ENTRY), reader({ [entry(BRIDGE, USER_SCOPE_ENTRY)]: GATED })), null);
  assert.equal(gateOf(entry(BRIDGE, USER_SCOPE_ENTRY), reader(NEW)), 1);
  assert.equal(SUPPORTED_GATE, 1);
});

test("every gated server: the plugin route", () => {
  assert.deepEqual(decideRoute(ready()), { route: "plugin", reason: "" });
});

for (const [name, over, said] of [
  ["no policy", { policyText: null }, /policy/],
  ["not installed", { installedText: null }, /not installed/],
  ["disabled", { settingsText: JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }) }, /disabled/],
  ["the plugin runs another bridge", { manifestText: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [entry(OLD_BRIDGE, PLUGIN_ENTRY)] } } }) }, /does not run/],
  ["a partial copy: the plugin entry without a gated claude-channel.js", { readScript: reader({ [entry(BRIDGE, PLUGIN_ENTRY)]: ENTRY, [entry(BRIDGE, USER_SCOPE_ENTRY)]: "old" }) }, /claude-channel\.js does not declare/],
  ["a downgrade: no plugin entry at all", { readScript: reader({ [entry(BRIDGE, USER_SCOPE_ENTRY)]: GATED }) }, /claude-channel-plugin\.mjs is missing/],
  ["a gate version this launcher does not know", { readScript: reader({ [entry(BRIDGE, PLUGIN_ENTRY)]: ENTRY, [entry(BRIDGE, USER_SCOPE_ENTRY)]: "export const CHANNEL_PRODUCER_GATE = 2;" }) }, /declare producer gate 1/],
  ["the user-scope server runs an old, ungated bridge", { configs: [user(servers(entry(OLD_BRIDGE, USER_SCOPE_ENTRY)))] }, /user server aify-comms-channel runs .*old/],
]) {
  test(`${name}: the development route, saying why`, () => {
    const decision = decideRoute(ready(over));
    assert.equal(decision.route, "dev", JSON.stringify(decision));
    assert.match(decision.reason, said);
  });
}

test("a channel server in any scope counts: local, project and the launcher's session config", () => {
  const ungated = servers(entry(OLD_BRIDGE, USER_SCOPE_ENTRY));
  for (const scope of ["local", "project", "session"]) {
    const configs = [user(servers(entry(BRIDGE, USER_SCOPE_ENTRY))), { scope, text: ungated, servers: (p) => p.mcpServers }];
    assert.match(decideRoute(ready({ configs })).reason, new RegExp(`the ${scope} server`), scope);
  }
  // A server under another name running the channel script is a channel server too; one running no readable script is
  // not something this launcher can vouch for.
  const renamed = JSON.stringify({ mcpServers: { "my-channel": { command: "node", args: [entry(OLD_BRIDGE, USER_SCOPE_ENTRY)] } } });
  assert.match(decideRoute(ready({ configs: [user(servers(entry(BRIDGE, USER_SCOPE_ENTRY))), { scope: "project", text: renamed, servers: (p) => p.mcpServers }] })).reason, /my-channel/);
  const opaque = JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "/usr/bin/wrapper" } } });
  assert.match(decideRoute(ready({ configs: [user(opaque)] })).reason, /runs no channel script/);
});

test("no development server configured: the plugin route if ready, else none with the reason", () => {
  assert.equal(decideRoute(ready({ configs: [] })).route, "plugin", "absent is fine for the plugin route");
  const none = decideRoute(ready({ configs: [], policyText: null }));
  assert.equal(none.route, "none");
  assert.match(none.reason, /no aify-comms-channel server is configured/);
});

test("a configuration present but unreadable: the development route, never a guess", () => {
  const decision = decideRoute(ready({ configs: [user("{ not json")] }));
  assert.equal(decision.route, "dev");
  assert.match(decision.reason, /user configuration is not readable/);
  assert.equal(configuredChannels([user(null)]).found.length, 0);
});

test("channel servers are found by name or by script; other servers are not", () => {
  assert.deepEqual(channelServers({ a: { command: "node", args: ["/x/claude-channel.js"] }, b: { command: "node", args: ["/x/server.js"] } }),
    [{ name: "a", script: "/x/claude-channel.js" }]);
  assert.deepEqual(channelServers(undefined), []);
  assert.ok(samePath("C:\\Users\\A\\x", "c:/users/a/x/", "win32"));
  assert.ok(!samePath("C:/Users/A/x", "c:/users/a/x", "linux"));
  assert.ok(!samePath("", "", "linux"));
});

test("on the machine: Claude's own files, CLAUDE_CONFIG_DIR honoured, the folder's local scope matched", () => {
  const home = path.join("/h");
  const cwd = path.join("/work");
  assert.deepEqual(claudeConfigPaths({ home, env: {} }), { dir: path.join(home, ".claude"), claudeJson: path.join(home, ".claude.json") });
  assert.deepEqual(claudeConfigPaths({ home, env: { CLAUDE_CONFIG_DIR: "/c" } }), { dir: "/c", claudeJson: path.join("/c", ".claude.json") });
  const files = {
    ...NEW, ...OLD,
    [path.join(home, ".claude", "plugins", "installed_plugins.json")]: ready().installedText,
    [path.join("/cache", ".claude-plugin", "plugin.json")]: ready().manifestText,
    [path.join(home, ".claude.json")]: JSON.stringify({ mcpServers: JSON.parse(servers(entry(BRIDGE, USER_SCOPE_ENTRY))).mcpServers,
      projects: { [cwd]: { mcpServers: JSON.parse(servers(entry(OLD_BRIDGE, USER_SCOPE_ENTRY))).mcpServers } } }),
  };
  const readFile = (file) => { if (file in files) return files[file]; throw new Error(`ENOENT ${file}`); };
  const policy = (source) => (source.admin ? withOurChannel("").text : null);
  const here = (over) => routeHere({ platform: "linux", home, env: {}, bridgeDir: BRIDGE, read: policy, readFile, ...over });
  assert.match(here({ cwd }).reason, /local server/, "the folder's local scope runs an old bridge");
  assert.equal(here({ cwd: "/elsewhere" }).route, "plugin");
  assert.match(here({ cwd: "/elsewhere", sessionConfigText: servers(entry(OLD_BRIDGE, USER_SCOPE_ENTRY)) }).reason, /session server/);
});

test("the launcher's own inputs: another service, or arguments that bring their own channels, keep the development route", () => {
  const here = () => ({ route: "plugin", reason: "" });
  assert.equal(routeFor({ service: "aify-comms", args: [], sessionConfig: "", here }).route, "plugin");
  assert.equal(routeFor({ service: "other", args: [], sessionConfig: "", here }).route, "dev");
  for (const arg of ["--mcp-config", "--mcp-config=/x", "--strict-mcp-config", "--channels", "--plugin-dir=/p", "--dangerously-load-development-channels"]) {
    assert.ok(namesItsOwnChannels(["-p", arg]), arg);
    assert.equal(routeFor({ service: "aify-comms", args: [arg], sessionConfig: "", here }).route, "dev", arg);
  }
  assert.ok(!namesItsOwnChannels(["do --channels-like things", "--model"]));
  let seen;
  routeFor({ service: "aify-comms", args: [], sessionConfig: Buffer.from("{\"a\":1}").toString("base64"), here: (o) => { seen = o; return here(); } });
  assert.equal(seen.sessionConfigText, "{\"a\":1}");
  assert.equal(pluginBlocker({ ...ready(), channels: [] }), "");
});
