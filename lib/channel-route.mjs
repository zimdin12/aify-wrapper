// How claude-aify loads aify-comms' channel: the aify-channel plugin (`--channels plugin:aify-channel@aify-local`, no
// development-channels prompt), today's development channel (`--dangerously-load-development-channels
// server:aify-comms-channel`), or not at all, with the reason.
//
// BOTH CONFIGURED SERVERS START, WHATEVER THE ROUTE (aify-wrapper docs/evidence/2026-10-22-channel-plugin, D-F). Each
// one decides for itself whether it claims messages, from the AIFY_CHANNEL_ROUTE the launcher exports (aify-comms
// mcp/stdio/channel-producer.mjs). A server that predates that decision claims whatever the route, and on the plugin
// route its events are dropped and its claims are lost. So the plugin route is taken only when every channel server
// this session would run runs the producer gate: `export const CHANNEL_PRODUCER_GATE = 1;` in claude-channel.js, which
// the plugin's entry runs too. The declaration is a versioned interface claim made by aify-comms; this module reads it
// and never runs the file.
//
// THE PLUGIN ROUTE when all of these hold, read-only:
//   1. the effective managed policy admits the plugin (lib/channel-policy.mjs);
//   2. the plugin is installed and not disabled;
//   3. its server runs `node <this launcher's bridge>/claude-channel-plugin.mjs`, that entry exists, and the
//      claude-channel.js beside it declares gate 1;
//   4. every other channel server in the user scope, the local scope for this folder, the folder's .mcp.json, and
//      the session config the launcher adds runs gate 1 the same way.
// Otherwise the DEVELOPMENT ROUTE, when a server named aify-comms-channel is configured for it to load. With neither,
// NONE: the session would start with no channel, and the launcher says how to repair that instead.
// A configuration file that is present but unreadable stops the decision at the development route, today's behaviour.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { admitsOurChannel, effectivePolicy, OUR_ENTRY, parsePolicy, readSource } from "./channel-policy.mjs";

export const PLUGIN_ID = `${OUR_ENTRY.plugin}@${OUR_ENTRY.marketplace}`;
export const CHANNEL_SERVER = "aify-comms-channel";
export const PLUGIN_ENTRY = "claude-channel-plugin.mjs";
export const USER_SCOPE_ENTRY = "claude-channel.js";
/** The producer-gate versions this launcher knows the meaning of. */
export const SUPPORTED_GATE = 1;

const CHANNEL_SCRIPT = /(^|[\\/])claude-channel(-plugin)?\.m?js$/;
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A path in one spelling, for comparison: forward slashes, and case folded where the file system folds it. */
export function samePath(a, b, platform = process.platform) {
  const norm = (p) => { const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, ""); return platform === "win32" ? s.toLowerCase() : s; };
  return norm(a) !== "" && norm(a) === norm(b);
}

/** The gate version a script's text declares, or null. */
export function declaredGate(text) {
  const match = /^export const CHANNEL_PRODUCER_GATE = (\d+);$/m.exec(String(text ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * The gate a channel script runs. claude-channel.js declares it; the plugin's entry runs that file's runChannel(),
 * so it runs the gate declared beside it, and only if it exists at all.
 */
export function gateOf(script, readScript) {
  if (path.basename(String(script)) !== PLUGIN_ENTRY) return declaredGate(readScript(script));
  if (readScript(script) === null) return null;
  return declaredGate(readScript(path.join(path.dirname(String(script)), USER_SCOPE_ENTRY)));
}

/** The servers in one configuration that run aify-comms' channel: named for it, or running its script. */
export function channelServers(servers) {
  if (!isObject(servers)) return [];
  return Object.entries(servers)
    .filter(([name, s]) => name === CHANNEL_SERVER || (Array.isArray(s?.args) && s.args.some((a) => CHANNEL_SCRIPT.test(String(a)))))
    .map(([name, s]) => ({ name, script: Array.isArray(s?.args) ? (s.args.find((a) => CHANNEL_SCRIPT.test(String(a))) ?? null) : null }));
}

/**
 * The channel servers each configuration names. `configs` is [{scope, text, servers}], where `servers` picks the
 * mcpServers object out of the parsed text. A present file that is not JSON is reported, never read as empty.
 */
export function configuredChannels(configs) {
  const found = [];
  for (const { scope, text, servers } of configs) {
    if (text === null || text === undefined) continue;
    const parsed = parseJson(text);
    if (!isObject(parsed)) return { ok: false, reason: `the ${scope} configuration is not readable JSON` };
    for (const server of channelServers(servers(parsed))) found.push({ scope, ...server });
  }
  return { ok: true, found };
}

/** Why the plugin route cannot be taken, or "" when it can. */
export function pluginBlocker({ policyText, installedText, settingsText, manifestText, bridgeDir, channels, readScript, platform }) {
  const policy = parsePolicy(policyText);
  if (!policy.ok || !admitsOurChannel(policy.policy)) return "the managed policy does not admit the aify-channel plugin";
  const entries = parseJson(installedText ?? "")?.plugins?.[PLUGIN_ID];
  if (!(Array.isArray(entries) && entries.length)) return "the aify-channel plugin is not installed";
  if (parseJson(settingsText ?? "")?.enabledPlugins?.[PLUGIN_ID] === false) return "the aify-channel plugin is disabled";
  const server = parseJson(manifestText ?? "")?.mcpServers?.[CHANNEL_SERVER];
  const entry = path.join(bridgeDir ?? "", PLUGIN_ENTRY);
  if (!bridgeDir || server?.command !== "node" || !samePath(server?.args?.[0], entry, platform)) {
    return `the installed plugin does not run ${entry}; re-run channel-install.mjs install`;
  }
  if (readScript(entry) === null) return `${entry} is missing: that bridge predates the plugin`;
  if (gateOf(entry, readScript) !== SUPPORTED_GATE) {
    return `${path.join(bridgeDir, USER_SCOPE_ENTRY)} does not declare producer gate ${SUPPORTED_GATE}`;
  }
  for (const consumer of channels) {
    if (!consumer.script) return `the ${consumer.scope} server ${consumer.name} runs no channel script this launcher can read`;
    if (gateOf(consumer.script, readScript) !== SUPPORTED_GATE) {
      return `the ${consumer.scope} server ${consumer.name} runs ${consumer.script}, which does not declare producer gate ${SUPPORTED_GATE}`;
    }
  }
  return "";
}

/** The route, with the reason for anything but the plugin. */
export function decideRoute(facts) {
  const configured = configuredChannels(facts.configs);
  if (!configured.ok) return { route: "dev", reason: configured.reason };
  const blocker = pluginBlocker({ ...facts, channels: configured.found });
  if (!blocker) return { route: "plugin", reason: "" };
  if (configured.found.some((c) => c.name === CHANNEL_SERVER)) return { route: "dev", reason: blocker };
  return { route: "none", reason: `no ${CHANNEL_SERVER} server is configured for the development route, and ${blocker}` };
}

/** Where Claude keeps its own configuration: CLAUDE_CONFIG_DIR when set, else ~/.claude and ~/.claude.json. */
export function claudeConfigPaths({ home, env = {} }) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return { dir, claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(dir, ".claude.json") : path.join(home, ".claude.json") };
}

/**
 * The route on this host, read from the machine. `sessionConfigText` is the --mcp-config the launcher adds to every
 * session, decoded; `cwd` is the folder Claude starts in.
 */
export function routeHere({ platform = process.platform, home = os.homedir(), env = process.env, cwd = process.cwd(),
  bridgeDir = env.AIFY_BRIDGE_DIR, sessionConfigText = null, read = readSource,
  readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  const text = (file) => { try { return readFile(file); } catch { return null; } };
  const { dir, claudeJson } = claudeConfigPaths({ home, env });
  const installedText = text(path.join(dir, "plugins", "installed_plugins.json"));
  const installPath = parseJson(installedText ?? "")?.plugins?.[PLUGIN_ID]?.[0]?.installPath;
  const local = (parsed) => Object.entries(parsed.projects ?? {}).find(([key]) => samePath(key, cwd, platform))?.[1]?.mcpServers;
  return decideRoute({
    platform,
    bridgeDir,
    policyText: effectivePolicy(platform, (source) => read(source)).text,
    installedText,
    settingsText: text(path.join(dir, "settings.json")),
    manifestText: installPath ? text(path.join(installPath, ".claude-plugin", "plugin.json")) : null,
    readScript: text,
    configs: [
      { scope: "user", text: text(claudeJson), servers: (p) => p.mcpServers },
      { scope: "local", text: text(claudeJson), servers: local },
      { scope: "project", text: text(path.join(cwd, ".mcp.json")), servers: (p) => p.mcpServers },
      { scope: "session", text: sessionConfigText, servers: (p) => p.mcpServers },
    ],
  });
}
