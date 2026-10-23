// claude-aify asks this which channel route to take, passing the arguments it will hand Claude. It prints the route
// (`plugin`, `dev` or `none`) on the first line and the reason on the second, and exits 0. The environment carries
// AIFY_CHANNEL_SERVICE (the service the launcher serves), AIFY_BRIDGE_DIR (its bridge) and AIFY_CHANNEL_SESSION_MCP (the
// --mcp-config it adds, base64, or empty). Any failure here prints `dev`: today's route, which needs none of this.
import fs from "node:fs";

import { CHANNEL_SERVER, configuredChannels, devProvider, routeHere } from "./channel-route.mjs";
import { isMainModule } from "./main-module.mjs";

/** Arguments that bring MCP servers, plugins or channels this check cannot read: the plugin route is declined. */
export function namesItsOwnChannels(args) {
  return args.some((a) => /^--(mcp-config|strict-mcp-config|channels|dangerously-load-development-channels|plugin-dir)(=|$)/.test(a));
}

/** The values given to --mcp-config: `--mcp-config=v`, or every word after `--mcp-config` up to the next option. */
export function mcpConfigValues(args) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--mcp-config=")) { values.push(args[i].slice("--mcp-config=".length)); continue; }
    if (args[i] !== "--mcp-config") continue;
    while (i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[(i += 1)]);
  }
  return values;
}

/**
 * With the caller's own --strict-mcp-config, the session gets only the --mcp-config servers: the caller's and the one
 * the launcher adds. When every one of them can be read, the development route needs a usable aify-comms-channel among
 * them, or the session would start deaf. When any cannot be read, what they name is unknown and the default stands.
 */
export function strictDevProvider({ args, sessionConfigText, readFile }) {
  const configs = [];
  for (const value of mcpConfigValues(args)) {
    let text = value.trimStart().startsWith("{") ? value : null;
    if (text === null) {
      try { text = readFile(value); } catch { return { known: false }; }
    }
    configs.push({ scope: "--mcp-config", text, servers: (p) => p.mcpServers });
  }
  if (sessionConfigText) configs.push({ scope: "session", text: sessionConfigText, servers: (p) => p.mcpServers });
  const configured = configuredChannels(configs);
  if (!configured.ok) return { known: false };
  const read = (file) => { try { return readFile(file); } catch (error) { return error?.code === "ENOENT" ? null : { unreadable: String(error) }; } };
  return { known: true, ...devProvider(configured.found, read) };
}

/** The decision for one launch, before the machine is read. */
export function routeFor({ service, args, sessionConfig, here, readFile = (file) => fs.readFileSync(file, "utf8") }) {
  if (`${service}-channel` !== CHANNEL_SERVER) return { route: "dev", reason: "" };
  const sessionConfigText = sessionConfig ? Buffer.from(sessionConfig, "base64").toString("utf8") : null;
  if (namesItsOwnChannels(args)) {
    if (args.includes("--strict-mcp-config")) {
      const strict = strictDevProvider({ args, sessionConfigText, readFile });
      if (strict.known && !strict.usable) return { route: "none", reason: `--strict-mcp-config leaves ${strict.reason}` };
    }
    return { route: "dev", reason: "the arguments name MCP servers, plugins or channels themselves" };
  }
  return here({ sessionConfigText });
}

if (isMainModule(import.meta.url)) {
  let decision;
  try {
    decision = routeFor({ service: process.env.AIFY_CHANNEL_SERVICE, args: process.argv.slice(2),
      sessionConfig: process.env.AIFY_CHANNEL_SESSION_MCP || "", here: routeHere });
  } catch (error) {
    decision = { route: "dev", reason: `route check failed: ${error.message}` };
  }
  process.stdout.write(`${decision.route}\n${decision.reason.replace(/\s+/g, " ")}\n`);
}
