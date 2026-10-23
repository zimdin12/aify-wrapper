#!/usr/bin/env node
// The route claude-aify returns must leave exactly the producer that route expects, fallback included, and the
// development route needs a provider that will actually run. Review of a32b385 (aify-comms 1792722473099-5a0d08b5),
// CR1-CR5, each with its adverse and healthy controls.
//
// A server produces when (it runs the plugin's entry) === (the route it sees is "plugin"), and the route it sees is
// its own AIFY_CHANNEL_ROUTE when its env sets one, else the launcher's (aify-comms mcp/stdio/channel-producer.mjs).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { effectivePolicy, OUR_ENTRY, withOurChannel } from "../lib/channel-policy.mjs";
import { CHANNEL_SERVER, decideRoute, devProvider, gateOf, PLUGIN_ENTRY, PLUGIN_ID, routeHere, USER_SCOPE_ENTRY } from "../lib/channel-route.mjs";

const GATED = "export const CHANNEL_PRODUCER_GATE = 1;\n";
const ENTRY = 'import { runChannel } from "./claude-channel.js";\n';
const BRIDGE = path.join("/b", "mcp", "stdio");
const OTHER = path.join("/other", "mcp", "stdio");
const at = (dir, file) => path.join(dir, file);
const FILES = { [at(BRIDGE, PLUGIN_ENTRY)]: ENTRY, [at(BRIDGE, USER_SCOPE_ENTRY)]: GATED, [at(OTHER, PLUGIN_ENTRY)]: ENTRY, [at(OTHER, USER_SCOPE_ENTRY)]: GATED };
const legacy = (env) => ({ command: "node", args: [at(BRIDGE, USER_SCOPE_ENTRY)], ...(env ? { env } : {}) });
const manifest = (server = { command: "node", args: [at(BRIDGE, PLUGIN_ENTRY)] }) =>
  JSON.stringify({ name: OUR_ENTRY.plugin, version: "1.0.0", mcpServers: { [CHANNEL_SERVER]: server } });
const scope = (name, servers) => ({ scope: name, text: JSON.stringify({ mcpServers: servers }), servers: (p) => p.mcpServers });
const facts = (over = {}) => ({
  platform: "linux",
  bridgeDir: BRIDGE,
  policyText: withOurChannel("").text,
  installedText: JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "/cache" }] } }),
  settingsText: "{}",
  manifestText: manifest(),
  readScript: (file) => FILES[file] ?? null,
  configs: [scope("user", { [CHANNEL_SERVER]: legacy() })],
  ...over,
});

// ---- CR1: exclusivity survives the route actually returned ----

test("CR1: legacy server routed dev by its own env and the plugin's server routed plugin: refused, not dev with two producers", () => {
  const decision = decideRoute(facts({
    configs: [scope("user", { [CHANNEL_SERVER]: legacy({ AIFY_CHANNEL_ROUTE: "dev" }) })],
    manifestText: manifest({ command: "node", args: [at(BRIDGE, PLUGIN_ENTRY)], env: { AIFY_CHANNEL_ROUTE: "plugin" } }),
  }));
  assert.equal(decision.route, "none", JSON.stringify(decision));
  assert.match(decision.reason, /would produce beside/);
});

test("CR1 healthy: no overrides takes the plugin route; both consumers routed dev keep the legacy producer alone", () => {
  assert.deepEqual(decideRoute(facts()), { route: "plugin", reason: "" });
  const dev = decideRoute(facts({
    configs: [scope("user", { [CHANNEL_SERVER]: legacy({ AIFY_CHANNEL_ROUTE: "dev" }) })],
    manifestText: manifest({ command: "node", args: [at(BRIDGE, PLUGIN_ENTRY)], env: { AIFY_CHANNEL_ROUTE: "dev" } }),
  }));
  assert.equal(dev.route, "dev", JSON.stringify(dev));
});

test("CR1: a configured server running the plugin's entry is a plugin producer, wherever it lives", () => {
  for (const dir of [OTHER, BRIDGE]) {
    const decision = decideRoute(facts({ configs: [scope("user", { [CHANNEL_SERVER]: legacy(), extra: { command: "node", args: [at(dir, PLUGIN_ENTRY)] } })] }));
    assert.notEqual(decision.route, "plugin", `${dir}: ${JSON.stringify(decision)}`);
    assert.match(decision.reason, /runs the plugin's entry/, dir);
  }
  const replaced = decideRoute(facts({ configs: [scope("user", { [CHANNEL_SERVER]: legacy(), extra: { command: "node", args: [at(OTHER, USER_SCOPE_ENTRY)] } })] }));
  assert.deepEqual(replaced, { route: "plugin", reason: "" }, "a maintained legacy entry in its place is healthy");
});

test("CR1: an AIFY_CHANNEL_ROUTE spelled twice with different values is refused, not guessed", () => {
  const decision = decideRoute(facts({ configs: [scope("user", { [CHANNEL_SERVER]: legacy({ aify_channel_route: "plugin", AIFY_CHANNEL_ROUTE: "dev" }) })] }));
  assert.notEqual(decision.route, "plugin", JSON.stringify(decision));
  assert.match(decision.reason, /more than one spelling/);
});

// ---- CR2: a named record is a development provider only if it will run and produce ----

const noPlugin = (configs, over = {}) => facts({ policyText: null, installedText: null, manifestText: null, configs, ...over });

test("CR2: a named record running the plugin's entry is no development provider; claude-channel.js in its place is", () => {
  const plugin = decideRoute(noPlugin([scope("user", { [CHANNEL_SERVER]: { command: "node", args: [at(BRIDGE, PLUGIN_ENTRY)] } })]));
  assert.equal(plugin.route, "none", JSON.stringify(plugin));
  assert.match(plugin.reason, /plugin's entry/);
  assert.equal(decideRoute(noPlugin([scope("user", { [CHANNEL_SERVER]: legacy() })])).route, "dev");
});

test("CR2: a local record replaces the user record of the same name: a missing local script is no provider", () => {
  const configs = [scope("user", { [CHANNEL_SERVER]: legacy() }), scope("local", { [CHANNEL_SERVER]: { command: "node", args: ["/gone/claude-channel.js"] } })];
  const shadowed = decideRoute(noPlugin(configs));
  assert.equal(shadowed.route, "none", JSON.stringify(shadowed));
  assert.match(shadowed.reason, /missing/);
  assert.equal(decideRoute(noPlugin([configs[0]])).route, "dev", "without the local record the user one provides");
  assert.equal(decideRoute(noPlugin([configs[0], scope("local", { [CHANNEL_SERVER]: legacy() })])).route, "dev", "a healthy local record provides");
});

// ---- CR3: explicit disabling counts ----

test("CR3: a provider named in disabledMcpServers is disabled; removing the entry is the control", () => {
  const configs = [scope("user", { [CHANNEL_SERVER]: legacy() })];
  const off = decideRoute(noPlugin(configs, { disabledServers: [CHANNEL_SERVER] }));
  assert.equal(off.route, "none", JSON.stringify(off));
  assert.match(off.reason, /disabled/);
  assert.equal(decideRoute(noPlugin(configs, { disabledServers: [] })).route, "dev");
  const project = [scope("project", { [CHANNEL_SERVER]: legacy() })];
  assert.equal(decideRoute(noPlugin(project, { disabledMcpjsonServers: [CHANNEL_SERVER] })).route, "none", "a denied project server");
  assert.equal(decideRoute(noPlugin(project)).route, "dev");
});

test("CR3: a project setting that disables a server that may be the plugin's declines the plugin route", () => {
  const decision = decideRoute(facts({ disabledServers: [`plugin:${OUR_ENTRY.plugin}:${CHANNEL_SERVER}`] }));
  assert.notEqual(decision.route, "plugin", JSON.stringify(decision));
  assert.match(decision.reason, /disables a server/);
});

// ---- CR4: unresolved plugin inputs never qualify ----

test("CR4: an unreadable plugin entry is not a ready one, even beside a gated claude-channel.js", () => {
  const read = (file) => (file === at(BRIDGE, PLUGIN_ENTRY) ? { unreadable: "EACCES" } : FILES[file] ?? null);
  assert.equal(gateOf(at(BRIDGE, PLUGIN_ENTRY), read), null);
  const decision = decideRoute(facts({ readScript: read }));
  assert.notEqual(decision.route, "plugin", JSON.stringify(decision));
  assert.match(decision.reason, /could not be read/);
});

test("CR4: a manifest without the rendered name is not the one this package renders", () => {
  const nameless = JSON.stringify({ version: "1.0.0", mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [at(BRIDGE, PLUGIN_ENTRY)] } } });
  const decision = decideRoute(facts({ manifestText: nameless }));
  assert.notEqual(decision.route, "plugin", JSON.stringify(decision));
  assert.match(decision.reason, /manifest/);
});

test("CR4: a settings file present but not a JSON object declines; {} and an explicit false are the controls", () => {
  for (const text of ["{", "[]", "7"]) {
    const decision = decideRoute(facts({ settingsText: text }));
    assert.notEqual(decision.route, "plugin", `${text}: ${JSON.stringify(decision)}`);
    assert.match(decision.reason, /not readable JSON/, text);
  }
  assert.equal(decideRoute(facts({ settingsText: "{}" })).route, "plugin");
  assert.match(decideRoute(facts({ settingsText: JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }) })).reason, /disabled/);
});

// ---- CR5: an admin location this host cannot find is not absent ----

test("CR5: unknown Program Files declines the plugin route even with an admitting per-user policy", () => {
  const read = (s) => (s.kind === "registry" && !s.admin ? withOurChannel("").text : null);
  assert.ok(effectivePolicy("win32", read, {}).text?.unreadable, "an unknown admin location is not absence");
  assert.equal(effectivePolicy("win32", read, { ProgramFiles: "C:\\PF" }).source?.admin, false, "known and absent: HKCU answers");
  const home = path.join("/h");
  const files = {
    [at(BRIDGE, PLUGIN_ENTRY)]: ENTRY, [at(BRIDGE, USER_SCOPE_ENTRY)]: GATED,
    [path.join(home, ".claude", "plugins", "installed_plugins.json")]: JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "/cache" }] } }),
    [path.join("/cache", ".claude-plugin", "plugin.json")]: manifest(),
    [path.join(home, ".claude.json")]: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: legacy() } }),
  };
  const here = (env) => routeHere({ platform: "win32", home, env, cwd: "/work", bridgeDir: BRIDGE, read,
    readFile: (f) => { if (f in files) return files[f]; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
  assert.notEqual(here({}).route, "plugin");
  assert.equal(here({ ProgramFiles: "C:\\PF" }).route, "plugin", "a known Program Files with no admin policy is the control");
});

test("devProvider keeps the accepted default for forms this launcher does not read", () => {
  const named = [{ scope: "user", name: CHANNEL_SERVER, form: "unknown", entry: null, script: null, role: null, route: undefined, ambiguous: false }];
  assert.equal(devProvider(named, () => null).usable, true);
});

test("the role, producer and route helpers say what aify-comms' producer gate does", async () => {
  const { devConflict, ownRoutes, produces, roleOf } = await import("../lib/channel-route.mjs");
  assert.equal(roleOf(at(BRIDGE, PLUGIN_ENTRY)), "plugin");
  assert.equal(roleOf(at(BRIDGE, USER_SCOPE_ENTRY)), "user");
  assert.equal(roleOf(null), null);
  assert.equal(produces("plugin", undefined, "plugin"), true);
  assert.equal(produces("user", undefined, "plugin"), false);
  assert.equal(produces("user", undefined, "dev"), true);
  assert.equal(produces("plugin", "plugin", "dev"), true, "an own route overrides the launcher's");
  assert.deepEqual(ownRoutes({ env: { aify_channel_route: "plugin", AIFY_CHANNEL_ROUTE: "dev", OTHER: "x" } }), ["plugin", "dev"]);
  assert.equal(devConflict([], { installedText: null, manifestText: null }), "", "nothing installed, nothing configured: no conflict");
});

test("CR1: an unreadable configuration still never leaves the installed plugin producing beside the development channel", () => {
  const unreadableProject = { scope: "project", text: { unreadable: "EACCES" }, servers: (p) => p.mcpServers };
  const split = decideRoute(facts({
    configs: [scope("user", { [CHANNEL_SERVER]: legacy({ AIFY_CHANNEL_ROUTE: "dev" }) }), unreadableProject],
    manifestText: manifest({ command: "node", args: [at(BRIDGE, PLUGIN_ENTRY)], env: { AIFY_CHANNEL_ROUTE: "plugin" } }),
  }));
  assert.equal(split.route, "none", JSON.stringify(split));
  assert.match(split.reason, /would produce beside the development channel/);
  const plain = decideRoute(facts({ configs: [scope("user", { [CHANNEL_SERVER]: legacy() }), unreadableProject] }));
  assert.equal(plain.route, "dev", `no known conflicting plugin keeps the accepted default: ${JSON.stringify(plain)}`);
});
