// The route the adverse and healthy cases get from a given lib/channel-route.mjs. Usage: node route-cases.mjs <repo-root>
// Prints one line per case. Run against b3a9c3e's tree and the fixed tree to show what changed.
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] || ".");
const { decideRoute, CHANNEL_SERVER, PLUGIN_ENTRY, PLUGIN_ID, USER_SCOPE_ENTRY } = await import(pathToFileURL(path.join(root, "lib", "channel-route.mjs")).href);
const { withOurChannel } = await import(pathToFileURL(path.join(root, "lib", "channel-policy.mjs")).href);

const BRIDGE = path.join("/b", "mcp", "stdio");
const at = (file) => path.join(BRIDGE, file);
const FILES = { [at(PLUGIN_ENTRY)]: 'import { runChannel } from "./claude-channel.js";\n', [at(USER_SCOPE_ENTRY)]: "export const CHANNEL_PRODUCER_GATE = 1;\n", "/x/other.js": "// ungated\n" };
const facts = (server) => ({
  platform: "linux", bridgeDir: BRIDGE, policyText: withOurChannel("").text, settingsText: "{}",
  installedText: JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: "/cache" }] } }),
  manifestText: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [at(PLUGIN_ENTRY)] } } }),
  readScript: (file) => FILES[file] ?? null,
  configs: [{ scope: "user", text: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: server } }), servers: (p) => p.mcpServers }],
});
for (const [name, server] of [
  ["healthy", { command: "node", args: [at(USER_SCOPE_ENTRY)] }],
  ["pathname only in a non-script arg", { command: "node", args: ["/x/other.js", "--note", at(USER_SCOPE_ENTRY)] }],
  ["legacy server with explicit route=dev", { command: "node", args: [at(USER_SCOPE_ENTRY)], env: { AIFY_CHANNEL_ROUTE: "dev" } }],
]) {
  const d = decideRoute(facts(server));
  console.log(`${name}: ${d.route}${d.reason ? ` (${d.reason})` : ""}`);
}
