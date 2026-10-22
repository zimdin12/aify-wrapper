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
//      the session config the launcher adds runs gate 1 the same way: judged by the script node actually runs (its
//      first argument), never by a pathname elsewhere in its arguments;
//   5. no channel server, the plugin's included, sets AIFY_CHANNEL_ROUTE in its own env, which would override the
//      route the launcher exports.
//   6. every input it reads resolves: the plugin installed for the user's scope, no settings file (user, project,
//      local, managed) disabling it, the manifest holding exactly the one rendered server and no plugin .mcp.json,
//      and no file present but unreadable. Anything else declines the plugin route.
// Otherwise the DEVELOPMENT ROUTE, when a server named aify-comms-channel can produce for it (devProvider). With neither,
// NONE: the session would start with no channel, and the launcher says how to repair that instead.
// A configuration file that is present but unreadable stops the decision at the development route, today's behaviour,
// since what it names is unknown.

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

const ROUTE_VARIABLE = "AIFY_CHANNEL_ROUTE";
const isNode = (command) => /^node(\.exe)?$/i.test(String(command ?? "").split(/[\\/]/).pop());

/**
 * The script a configured server actually runs: node's first argument, when the server is stdio and that argument is
 * not an option. Anything else is unknown, never guessed from a pathname elsewhere in the arguments.
 */
export function entryScript(server) {
  if (!isObject(server) || (server.type !== undefined && server.type !== "stdio") || !isNode(server.command)) return null;
  const first = Array.isArray(server.args) ? server.args[0] : undefined;
  return typeof first === "string" && first !== "" && !first.startsWith("-") ? first : null;
}

/**
 * The AIFY_CHANNEL_ROUTE a server's own `env` sets, or undefined. Claude starts the server with that env over the
 * launcher's, so a server that sets it ignores the route the launcher exports. Names are matched without case, as
 * Windows matches them.
 */
export function ownRoute(server) {
  const env = isObject(server?.env) ? server.env : {};
  const name = Object.keys(env).find((key) => key.toUpperCase() === ROUTE_VARIABLE);
  return name === undefined ? undefined : String(env[name]);
}

/**
 * The servers in one configuration that run aify-comms' channel, or might: named for it, or naming its script
 * anywhere. Each is judged by the script it actually runs (null when that is not a channel script) and by the route
 * its own env sets.
 */
export function channelServers(servers) {
  if (!isObject(servers)) return [];
  return Object.entries(servers)
    .filter(([name, s]) => name === CHANNEL_SERVER || (Array.isArray(s?.args) && s.args.some((a) => CHANNEL_SCRIPT.test(String(a)))))
    .map(([name, s]) => {
      const entry = entryScript(s);
      const hasCommand = isObject(s) && typeof s.command === "string" && s.command.trim() !== "";
      const remote = isObject(s) && s.type !== undefined && s.type !== "stdio";
      // How far this launcher can judge it: `node` running a known script, a record with nothing to start, or a form
      // it does not read (another program, node options, a remote transport), which keeps today's default.
      // A path Claude expands before starting it (`${VAR}`, `~`) is not the file this launcher would read.
      const expands = entry !== null && /\$\{|^~/.test(entry);
      const form = expands ? "unknown" : entry !== null ? "node" : !remote && !hasCommand ? "invalid" : "unknown";
      return { name, entry, form, script: !expands && entry !== null && CHANNEL_SCRIPT.test(entry) ? entry : null, route: ownRoute(s) };
    });
}

/** A file that exists but could not be read: kept apart from absent (null) everywhere here. */
const unreadable = (text) => isObject(text) && Boolean(text.unreadable);

/**
 * The channel servers each configuration names. `configs` is [{scope, text, servers}], where `servers` picks the
 * mcpServers object out of the parsed text. A present file that is not JSON, or cannot be read, is reported, never
 * read as empty.
 */
export function configuredChannels(configs) {
  const found = [];
  for (const { scope, text, servers } of configs) {
    if (text === null || text === undefined) continue;
    if (unreadable(text)) return { ok: false, reason: `the ${scope} configuration could not be read: ${text.unreadable}` };
    const parsed = parseJson(text);
    if (!isObject(parsed)) return { ok: false, reason: `the ${scope} configuration is not readable JSON` };
    for (const server of channelServers(servers(parsed))) found.push({ scope, ...server });
  }
  return { ok: true, found };
}

/** A route a server's own env sets that differs from the one this session would take: it would not follow it. */
const conflicts = (own, route) => own !== undefined && own !== route;

/**
 * Why the plugin route cannot be taken, or "" when it can. Every input it cannot resolve declines the plugin route:
 * a file present but unreadable, a plugin installed for another scope, a setting anywhere that disables it, a plugin
 * that brings servers beyond the one this package renders.
 */
export function pluginBlocker({ policyText, installedText, settingsTexts = [], settingsText, manifestText, pluginMcpText = null,
  bridgeDir, channels, readScript, platform }) {
  const policy = parsePolicy(policyText);
  if (!policy.ok || !admitsOurChannel(policy.policy)) return "the managed policy does not admit the aify-channel plugin";
  if (policy.policy.enabledPlugins?.[PLUGIN_ID] === false) return "the managed policy disables the aify-channel plugin";
  for (const [what, text] of [["the installed-plugins record", installedText], ["the plugin's manifest", manifestText], ["the plugin's .mcp.json", pluginMcpText]]) {
    if (unreadable(text)) return `${what} could not be read: ${text.unreadable}`;
  }
  const entries = parseJson(installedText ?? "")?.plugins?.[PLUGIN_ID];
  if (!(Array.isArray(entries) && entries.length)) return "the aify-channel plugin is not installed";
  if (!entries.some((e) => e?.scope === "user")) return "the aify-channel plugin is installed only for another scope than the user's";
  for (const text of [settingsText, ...settingsTexts]) {
    if (unreadable(text)) return `a Claude settings file could not be read: ${text.unreadable}`;
    if (parseJson(text ?? "")?.enabledPlugins?.[PLUGIN_ID] === false) return "the aify-channel plugin is disabled";
  }
  const servers = parseJson(manifestText ?? "")?.mcpServers;
  if (!isObject(servers) || Object.keys(servers).length !== 1) {
    return "the installed plugin's manifest does not hold exactly the one server this package renders; re-run channel-install.mjs install";
  }
  if (pluginMcpText !== null && pluginMcpText !== undefined) {
    return "the installed plugin carries a .mcp.json, which brings servers this launcher did not render; re-run channel-install.mjs install";
  }
  const server = servers[CHANNEL_SERVER];
  const entry = path.join(bridgeDir ?? "", PLUGIN_ENTRY);
  if (!bridgeDir || server?.command !== "node" || !samePath(server?.args?.[0], entry, platform)) {
    return `the installed plugin does not run ${entry}; re-run channel-install.mjs install`;
  }
  if (conflicts(ownRoute(server), "plugin")) {
    return `the installed plugin's server sets ${ROUTE_VARIABLE} itself, so it would not follow the route; re-run channel-install.mjs install`;
  }
  if (readScript(entry) === null) return `${entry} is missing: that bridge predates the plugin`;
  if (gateOf(entry, readScript) !== SUPPORTED_GATE) {
    return `${path.join(bridgeDir, USER_SCOPE_ENTRY)} does not declare producer gate ${SUPPORTED_GATE}`;
  }
  for (const consumer of channels) {
    if (!consumer.script) return `the ${consumer.scope} server ${consumer.name} runs no channel script this launcher can read`;
    if (conflicts(consumer.route, "plugin")) {
      return `the ${consumer.scope} server ${consumer.name} sets ${ROUTE_VARIABLE}=${consumer.route} itself, so it would produce beside the plugin`;
    }
    if (gateOf(consumer.script, readScript) !== SUPPORTED_GATE) {
      return `the ${consumer.scope} server ${consumer.name} runs ${consumer.script}, which does not declare producer gate ${SUPPORTED_GATE}`;
    }
  }
  return "";
}

/**
 * Can the development route's `server:aify-comms-channel` produce? A record by that name that is known not to (a
 * `node` record whose script is missing, a record with no command, one whose own env routes it away from `dev`) is
 * not a provider. A form this launcher does not read keeps the accepted default: it is taken as a provider, unproven.
 */
export function devProvider(found, readScript) {
  const named = found.filter((c) => c.name === CHANNEL_SERVER);
  if (!named.length) return { usable: false, reason: `no ${CHANNEL_SERVER} server is configured for the development route` };
  const why = [];
  for (const c of named) {
    // The user-scope server produces on every route but `plugin` (aify-comms channel-producer.mjs), so only that
    // value, set in its own env, keeps it from producing for the development route.
    if (c.route === "plugin") { why.push(`the ${c.scope} ${c.name} sets ${ROUTE_VARIABLE}=${c.route} itself`); continue; }
    if (c.form === "invalid") { why.push(`the ${c.scope} ${c.name} has no command to start`); continue; }
    if (c.form === "node" && readScript(c.entry) === null) { why.push(`the ${c.scope} ${c.name} runs ${c.entry}, which is missing`); continue; }
    return { usable: true, reason: "" };
  }
  return { usable: false, reason: `no usable ${CHANNEL_SERVER} for the development route: ${why.join("; ")}` };
}

/** The route, with the reason for anything but the plugin. */
export function decideRoute(facts) {
  const configured = configuredChannels(facts.configs);
  if (!configured.ok) return { route: "dev", reason: configured.reason };
  const blocker = pluginBlocker({ ...facts, channels: configured.found });
  if (!blocker) return { route: "plugin", reason: "" };
  const dev = devProvider(configured.found, facts.readScript);
  if (dev.usable) return { route: "dev", reason: blocker };
  return { route: "none", reason: `${dev.reason}, and ${blocker}` };
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
  // Absent is null; present but unreadable is { unreadable }, which every reader here declines on.
  const text = (file) => {
    try {
      return readFile(file);
    } catch (error) {
      return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : { unreadable: `${file}: ${error?.message ?? error}` };
    }
  };
  const { dir, claudeJson } = claudeConfigPaths({ home, env });
  const installedText = text(path.join(dir, "plugins", "installed_plugins.json"));
  const userEntry = (parseJson(unreadable(installedText) ? "" : installedText ?? "")?.plugins?.[PLUGIN_ID] ?? []).find?.((e) => e?.scope === "user");
  const installPath = userEntry?.installPath;
  const local = (parsed) => Object.entries(parsed.projects ?? {}).find(([key]) => samePath(key, cwd, platform))?.[1]?.mcpServers;
  return decideRoute({
    platform,
    bridgeDir,
    policyText: effectivePolicy(platform, (source) => read(source)).text,
    installedText,
    settingsText: text(path.join(dir, "settings.json")),
    settingsTexts: [text(path.join(cwd, ".claude", "settings.json")), text(path.join(cwd, ".claude", "settings.local.json"))],
    manifestText: installPath ? text(path.join(installPath, ".claude-plugin", "plugin.json")) : null,
    pluginMcpText: installPath ? text(path.join(installPath, ".mcp.json")) : null,
    readScript: text,
    configs: [
      { scope: "user", text: text(claudeJson), servers: (p) => p.mcpServers },
      { scope: "local", text: text(claudeJson), servers: local },
      { scope: "project", text: text(path.join(cwd, ".mcp.json")), servers: (p) => p.mcpServers },
      { scope: "session", text: sessionConfigText, servers: (p) => p.mcpServers },
    ],
  });
}
