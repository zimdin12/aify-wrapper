// How claude-aify loads aify-comms' channel: as the aify-channel plugin, with no development-channels
// prompt, or as today's development channel.
//
// THE PLUGIN ROUTE ONLY WHEN ALL THREE HOLD, else the development channel, which always works:
//   1. the effective managed policy admits the plugin (lib/channel-policy.mjs). Without it Claude drops the
//      plugin's events ("not on the approved channels allowlist"), and the agent would never wake;
//   2. the plugin is installed and not disabled;
//   3. ~/.claude.json carries no user-scope `aify-comms-channel` server. That entry starts a SECOND copy of
//      the channel in every session, and two copies share one agent-scoped bridge id and race for the same
//      runs, so one could claim a message the other never delivers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { admitsOurChannel, effectivePolicy, OUR_ENTRY, parsePolicy, readSource } from "./channel-policy.mjs";

export const PLUGIN_ID = `${OUR_ENTRY.plugin}@${OUR_ENTRY.marketplace}`;
export const LEGACY_SERVER = "aify-comms-channel";

const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** Pure: the route from the three facts, with the first reason the plugin route was not taken. */
export function decideRoute({ policyText, installedText, settingsText, claudeJsonText }) {
  const policy = parsePolicy(policyText);
  if (!policy.ok || !admitsOurChannel(policy.policy)) return { route: "dev", reason: "the managed policy does not admit the aify-channel plugin" };
  const installed = parseJson(installedText ?? "");
  const entries = installed?.plugins?.[PLUGIN_ID];
  if (!(Array.isArray(entries) ? entries.length : entries)) return { route: "dev", reason: "the aify-channel plugin is not installed" };
  if (parseJson(settingsText ?? "")?.enabledPlugins?.[PLUGIN_ID] === false) return { route: "dev", reason: "the aify-channel plugin is disabled" };
  const claudeJson = parseJson(claudeJsonText ?? "");
  if (claudeJson?.mcpServers?.[LEGACY_SERVER]) {
    return { route: "dev", reason: `~/.claude.json still has a user-scope ${LEGACY_SERVER}; the plugin would run a second copy` };
  }
  return { route: "plugin", reason: "" };
}

/** The route on this host, read from the machine. */
export function routeHere({ platform = process.platform, home = os.homedir(), read = readSource,
  readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  const text = (file) => { try { return readFile(file); } catch { return null; } };
  return decideRoute({
    policyText: effectivePolicy(platform, (source) => read(source)).text,
    installedText: text(path.join(home, ".claude", "plugins", "installed_plugins.json")),
    settingsText: text(path.join(home, ".claude", "settings.json")),
    claudeJsonText: text(path.join(home, ".claude.json")),
  });
}
