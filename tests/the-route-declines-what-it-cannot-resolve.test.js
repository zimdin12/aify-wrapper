#!/usr/bin/env node
// The plugin route is taken only on inputs this launcher resolves; the development route only with a provider that
// can produce; the managed policy only from the source Claude would apply. Review of b3a9c3e (aify-comms
// 1792706363368-70ad47a0), findings S1-S3 and S6, each with its adverse and healthy controls.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { installChannel } from "../lib/channel-install.mjs";
import { effectivePolicy, planInstall, policySources, readSource, settingsFromRegExport, withOurChannel } from "../lib/channel-policy.mjs";
import { CHANNEL_SERVER, decideRoute, PLUGIN_ENTRY, PLUGIN_ID, routeHere, USER_SCOPE_ENTRY } from "../lib/channel-route.mjs";
import { routeFor } from "../lib/channel-route-cli.mjs";

const PF = { ProgramFiles: "C:\\PF" };
const HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
const HKLM = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";
const HEADER = "[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\ClaudeCode]";
const exportText = (...lines) => ["Windows Registry Editor Version 5.00", "", ...lines, "", ""].join("\r\n");
const ADMITS = withOurChannel("").text;
const ENOENT = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
const EACCES = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };

// ---- S1: the value's identity is Windows', and refusal writes nothing ----

test("S1: the canonical Settings is read, a sibling name is not, and a case-varied non-string refuses with no write", () => {
  assert.equal(settingsFromRegExport(exportText(HEADER, `"Settings"="{}"`, `"SettingsBackup"="{\\"x\\":1}"`), HKCU), "{}");
  assert.equal(settingsFromRegExport(exportText(HEADER, `"SettingsBackup"="{}"`, `"Settings2"="{}"`), HKCU), null, "siblings are not Settings");
  const dword = settingsFromRegExport(exportText(HEADER, `"settings"=dword:00000001`), HKCU);
  assert.ok(dword?.unreadable, JSON.stringify(dword));
  const writes = [];
  const result = installChannel({
    bridgeDir: "/b", platform: "win32", home: "/h",
    read: (s) => (s.key === HKCU ? dword : s.kind === "unknown" ? null : null),
    write: (...args) => { writes.push(args); return { ok: true }; },
    readScript: (f) => (f.endsWith(PLUGIN_ENTRY) ? "import" : "export const CHANNEL_PRODUCER_GATE = 1;\n"),
    writeFiles: () => { throw new Error("must not render"); }, claude: () => { throw new Error("must not run claude"); },
  });
  assert.equal(result.ok, false);
  // Without ProgramFiles the admin file's location is unknown and the install refuses earlier, which is also no write.
  if (process.env.ProgramFiles) assert.match(result.reason, /not a plain string/);
  assert.deepEqual(writes, [], "a refusal records no write");
});

// ---- S2: the admin source Claude applies, composed and present by its own rules ----

const sourcesRead = ({ hklm = null, base = null, dropIns = null, hkcu = null }) => (source) => {
  if (source.kind === "registry") return source.admin ? hklm : hkcu;
  if (source.kind === "file") return base;
  if (source.kind === "dir") return dropIns === null ? null : readSource(source, { readDir: dropIns });
  return null;
};

test("S2: an admitting base file with an overriding drop-in is not the base's policy: the install refuses", () => {
  const read = sourcesRead({ base: ADMITS, dropIns: () => ["20-channels-off.json"] });
  assert.equal(effectivePolicy("win32", read, PF).source.kind, "dir");
  assert.equal(planInstall("win32", read, PF).action, "refuse");
});

test("S2: an admitting base file with an unreadable drop-in directory refuses", () => {
  const read = sourcesRead({ base: ADMITS, dropIns: EACCES });
  assert.ok(effectivePolicy("win32", read, PF).text?.unreadable);
  assert.equal(planInstall("win32", read, PF).action, "refuse");
});

test("S2: an empty HKLM Settings is malformed admin policy, never absence; an empty file is no policy", () => {
  const empty = effectivePolicy("win32", sourcesRead({ hklm: "" }), PF);
  assert.equal(empty.source.key, HKLM);
  assert.ok(empty.text?.unreadable, JSON.stringify(empty));
  assert.equal(planInstall("win32", sourcesRead({ hklm: "" }), PF).action, "refuse");
  assert.equal(planInstall("win32", sourcesRead({ hklm: null }), PF).action, "write", "absent HKLM plans the per-user write");
  assert.equal(planInstall("win32", sourcesRead({ base: "  " }), PF).action, "write", "an empty managed file is no policy");
});

test("S2 positive: an admitting base file with no drop-ins is the admin policy, and nothing is written", () => {
  const read = sourcesRead({ base: ADMITS, dropIns: () => ["notes.txt"] });
  assert.equal(effectivePolicy("win32", read, PF).source.kind, "file");
  assert.equal(planInstall("win32", read, PF).action, "none");
  assert.equal(policySources("win32", PF).filter((s) => s.admin && s.kind !== "registry").length, 2);
});

// ---- S3: the development route needs a provider that can produce ----

const BRIDGE = path.join("/b", "mcp", "stdio");
const at = (file) => path.join(BRIDGE, file);
const GATED = "export const CHANNEL_PRODUCER_GATE = 1;\n";
const user = (server) => ({ scope: "user", text: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: server } }), servers: (p) => p.mcpServers });
const devFacts = (server, files = { [at(USER_SCOPE_ENTRY)]: GATED }) => ({
  platform: "linux", bridgeDir: BRIDGE, policyText: null, installedText: null, settingsText: null, manifestText: null,
  readScript: (f) => files[f] ?? null, configs: [user(server)],
});

test("S3: a named record that cannot produce is refused with repair, not the development route", () => {
  for (const [what, server, said] of [
    ["its script is missing", { command: "node", args: ["/gone/claude-channel.js"] }, /missing/],
    ["it has no command", { args: [at(USER_SCOPE_ENTRY)] }, /no command/],
    ["its own env routes it to the plugin", { command: "node", args: [at(USER_SCOPE_ENTRY)], env: { AIFY_CHANNEL_ROUTE: "plugin" } }, /AIFY_CHANNEL_ROUTE=plugin/],
  ]) {
    const decision = decideRoute(devFacts(server));
    assert.equal(decision.route, "none", `${what}: ${JSON.stringify(decision)}`);
    assert.match(decision.reason, said, what);
  }
});

test("S3: a usable provider, or a form this launcher does not read, keeps the development route", () => {
  assert.equal(decideRoute(devFacts({ command: "node", args: [at(USER_SCOPE_ENTRY)] })).route, "dev");
  assert.equal(decideRoute(devFacts({ command: "bun", args: ["run", "x"] })).route, "dev", "unknown foreign input keeps the default");
  assert.equal(decideRoute(devFacts({ type: "http", url: "http://x" })).route, "dev", "a remote transport keeps the default");
  assert.equal(decideRoute(devFacts({ command: "node", args: ["${HOME}/mcp/claude-channel.js"] })).route, "dev", "a path Claude expands is not read here");
  assert.equal(decideRoute(devFacts({ command: "node", args: ["~/mcp/claude-channel.js"] })).route, "dev", "nor a ~ path");
});

test("S3: the caller's own --strict-mcp-config with no usable provider is refused; with one, or unreadable input, dev", () => {
  const here = () => ({ route: "plugin", reason: "" });
  const files = { "/cfg/ok.json": JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [at(USER_SCOPE_ENTRY)] } } }), [at(USER_SCOPE_ENTRY)]: GATED };
  const readFile = (f) => { if (f in files) return files[f]; return ENOENT(); };
  const route = (args) => routeFor({ service: "aify-comms", args, sessionConfig: "", here, readFile });
  assert.equal(route(["--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"]).route, "none");
  assert.equal(route(["--strict-mcp-config", "--mcp-config={\"mcpServers\":{}}", "-p", "x"]).route, "none");
  assert.equal(route(["--strict-mcp-config", "--mcp-config", "/cfg/ok.json"]).route, "dev");
  assert.equal(route(["--strict-mcp-config", "--mcp-config", "/cfg/unreadable.json"]).route, "dev", "unknown input keeps the default");
  assert.equal(route(["--mcp-config", "{\"mcpServers\":{}}"]).route, "dev", "without strict the operator's servers still load");
  assert.equal(route(["--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "/cfg/ok.json", "-p"]).route, "dev", "every value after --mcp-config counts");
});

test("S3 helpers: the --mcp-config values, the strict provider, the development provider", async () => {
  const { mcpConfigValues, strictDevProvider } = await import("../lib/channel-route-cli.mjs");
  const { devProvider } = await import("../lib/channel-route.mjs");
  assert.deepEqual(mcpConfigValues(["--mcp-config", "a", "b", "-p", "--mcp-config=c"]), ["a", "b", "c"]);
  assert.deepEqual(mcpConfigValues(["--strict-mcp-config"]), []);
  const readFile = (f) => (f === at(USER_SCOPE_ENTRY) ? GATED : ENOENT());
  assert.deepEqual(strictDevProvider({ args: ["--strict-mcp-config"], sessionConfigText: null, readFile }),
    { known: true, usable: false, reason: `no ${CHANNEL_SERVER} server is configured for the development route` });
  const session = JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [at(USER_SCOPE_ENTRY)] } } });
  assert.equal(strictDevProvider({ args: ["--strict-mcp-config"], sessionConfigText: session, readFile }).usable, true, "the launcher's own config counts");
  assert.deepEqual(strictDevProvider({ args: ["--strict-mcp-config", "--mcp-config", "/nope.json"], sessionConfigText: null, readFile }), { known: false });
  const named = (server) => [{ scope: "user", name: CHANNEL_SERVER, ...server }];
  assert.equal(devProvider([], () => null).usable, false);
  assert.equal(devProvider(named({ form: "node", entry: "/x.js" }), () => "x").usable, true);
  assert.equal(devProvider(named({ form: "node", entry: "/x.js" }), () => null).usable, false);
  assert.equal(devProvider(named({ form: "unknown", entry: null }), () => null).usable, true);
});

// ---- S6: every consumer the plugin brings, and every input read or declined ----

const home = path.join("/h");
const cwd = path.join("/work");
const CACHE = path.join("/cache");
const machine = (over = {}) => ({
  [at(PLUGIN_ENTRY)]: 'import { runChannel } from "./claude-channel.js";\n',
  [at(USER_SCOPE_ENTRY)]: GATED,
  [path.join(home, ".claude", "plugins", "installed_plugins.json")]: JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "user", installPath: CACHE }] } }),
  [path.join(CACHE, ".claude-plugin", "plugin.json")]: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [at(PLUGIN_ENTRY)] } } }),
  [path.join(home, ".claude.json")]: JSON.stringify({ mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [at(USER_SCOPE_ENTRY)] } } }),
  ...over,
});
const hereOn = (files, denied = []) => routeHere({
  platform: "linux", home, env: {}, cwd, bridgeDir: BRIDGE, read: (s) => (s.admin && s.kind === "file" ? ADMITS : null),
  readFile: (f) => (denied.includes(f) ? EACCES() : f in files ? files[f] : ENOENT()),
});

test("S6 healthy: the rendered shape on a readable machine takes the plugin route", () => {
  assert.deepEqual(hereOn(machine()), { route: "plugin", reason: "" });
});

test("S6: a second consumer in the plugin's manifest, or a plugin .mcp.json, declines the plugin route", () => {
  const extra = machine({ [path.join(CACHE, ".claude-plugin", "plugin.json")]: JSON.stringify({ mcpServers: {
    [CHANNEL_SERVER]: { command: "node", args: [at(PLUGIN_ENTRY)] }, old: { command: "node", args: ["/old/claude-channel.js"] } } }) });
  assert.match(hereOn(extra).reason, /exactly the one server/);
  const mcp = machine({ [path.join(CACHE, ".mcp.json")]: JSON.stringify({ mcpServers: {} }) });
  assert.match(hereOn(mcp).reason, /\.mcp\.json/);
  for (const decision of [hereOn(extra), hereOn(mcp)]) assert.equal(decision.route, "dev");
});

test("S6: a present file that cannot be read is not absent: the plugin route is declined", () => {
  for (const file of [path.join(home, ".claude.json"), path.join(home, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"), path.join(home, ".claude", "plugins", "installed_plugins.json")]) {
    const decision = hereOn(machine(), [file]);
    assert.notEqual(decision.route, "plugin", `${file}: ${JSON.stringify(decision)}`);
    assert.match(decision.reason, /could not be read/, file);
  }
});

test("S6: a plugin installed only for another scope, or disabled by a project or local setting, declines", () => {
  const project = machine({ [path.join(home, ".claude", "plugins", "installed_plugins.json")]:
    JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: "project", projectPath: "/other", installPath: CACHE }] } }) });
  assert.match(hereOn(project).reason, /another scope/);
  for (const name of ["settings.json", "settings.local.json"]) {
    const off = machine({ [path.join(cwd, ".claude", name)]: JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }) });
    assert.match(hereOn(off).reason, /disabled/, name);
  }
});
