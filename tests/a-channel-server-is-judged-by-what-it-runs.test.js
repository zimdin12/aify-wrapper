#!/usr/bin/env node
// The plugin route judges each channel server by what it actually runs and by the route it actually sees.
//
// Review of b3a9c3e (aify-comms 1792704666296-d912db2f): eligibility took a gated pathname from anywhere in a
// server's arguments, so `node other.js --note <bridge>/claude-channel.js` passed while running other.js. It also
// ignored a server's own `env`: Claude starts an MCP server with that env over the launcher's, so a legacy server
// that sets AIFY_CHANNEL_ROUTE=dev itself keeps producing beside the plugin and the message is claimed twice. Both
// leave the plugin route refused, with the reason; a healthy host still takes it.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { withOurChannel } from "../lib/channel-policy.mjs";
import { CHANNEL_SERVER, channelServers, decideRoute, entryScript, ownRoute, PLUGIN_ENTRY, PLUGIN_ID,
  USER_SCOPE_ENTRY } from "../lib/channel-route.mjs";

const GATED = "export const CHANNEL_PRODUCER_GATE = 1;\n";
const BRIDGE = path.join("/b", "mcp", "stdio");
const at = (file) => path.join(BRIDGE, file);
const FILES = { [at(PLUGIN_ENTRY)]: 'import { runChannel } from "./claude-channel.js";\n', [at(USER_SCOPE_ENTRY)]: GATED, "/x/other.js": "// ungated\n" };
const user = (server) => ({ scope: "user", text: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: server } }), servers: (p) => p.mcpServers });
const facts = (server, manifestServer = { command: "node", args: [at(PLUGIN_ENTRY)] }) => ({
  platform: "linux",
  bridgeDir: BRIDGE,
  policyText: withOurChannel("").text,
  installedText: JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "/cache" }] } }),
  settingsText: "{}",
  manifestText: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: manifestServer } }),
  readScript: (file) => FILES[file] ?? null,
  configs: [user(server)],
});

test("healthy: node running the gated script, with only its own service variables, takes the plugin route", () => {
  const server = { type: "stdio", command: "node", args: [at(USER_SCOPE_ENTRY)], env: { AIFY_SERVER_URL: "http://s", AIFY_API_KEY: "k" } };
  assert.deepEqual(decideRoute(facts(server)), { route: "plugin", reason: "" });
  assert.deepEqual(decideRoute(facts({ ...server, command: "C:\\Program Files\\nodejs\\node.exe" })), { route: "plugin", reason: "" });
});

test("a gated pathname only in a non-script argument is not what the server runs: no plugin route", () => {
  for (const args of [["/x/other.js", "--note", at(USER_SCOPE_ENTRY)], ["--require", at(USER_SCOPE_ENTRY), "/x/other.js"], [at(USER_SCOPE_ENTRY)]]) {
    for (const command of args.length === 1 ? ["bun", "cmd"] : ["node"]) {
      const decision = decideRoute(facts({ command, args }));
      assert.equal(decision.route, "dev", `${command} ${args.join(" ")}: ${JSON.stringify(decision)}`);
      assert.match(decision.reason, /runs no channel script this launcher can read/, `${command} ${args.join(" ")}`);
    }
  }
  assert.equal(channelServers({ s: { command: "node", args: ["/x/other.js", "--note", at(USER_SCOPE_ENTRY)] } })[0]?.script, null);
});

test("a legacy server that sets AIFY_CHANNEL_ROUTE itself would produce beside the plugin: no plugin route", () => {
  for (const env of [{ AIFY_CHANNEL_ROUTE: "dev" }, { aify_channel_route: "dev" }, { AIFY_CHANNEL_ROUTE: "" }, { AIFY_CHANNEL_ROUTE: "plugin" }]) {
    const decision = decideRoute(facts({ command: "node", args: [at(USER_SCOPE_ENTRY)], env }));
    assert.equal(decision.route, "dev", `${JSON.stringify(env)}: ${JSON.stringify(decision)}`);
    assert.match(decision.reason, /sets AIFY_CHANNEL_ROUTE itself, so the route this launcher exports does not reach it/, JSON.stringify(env));
  }
});

test("the plugin's own server setting AIFY_CHANNEL_ROUTE is refused the same way", () => {
  const decision = decideRoute(facts({ command: "node", args: [at(USER_SCOPE_ENTRY)] },
    { command: "node", args: [at(PLUGIN_ENTRY)], env: { AIFY_CHANNEL_ROUTE: "dev" } }));
  assert.equal(decision.route, "dev", JSON.stringify(decision));
  assert.match(decision.reason, /sets AIFY_CHANNEL_ROUTE itself/);
});

test("the entry script and the server's own route, read directly", () => {
  assert.equal(entryScript({ command: "node", args: ["/a.js", "x"] }), "/a.js");
  assert.equal(entryScript({ type: "sse", command: "node", args: ["/a.js"] }), null);
  assert.equal(entryScript({ command: "node", args: ["-r", "/a.js"] }), null);
  assert.equal(entryScript({ command: "nodemon", args: ["/a.js"] }), null);
  assert.equal(ownRoute({ env: { AIFY_CHANNEL_ROUTE: "dev" } }), "dev");
  assert.equal(ownRoute({ env: { OTHER: "x" } }), undefined);
  assert.equal(ownRoute({}), undefined);
});
