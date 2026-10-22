// claude-aify asks this which channel route to take, passing the arguments it will hand Claude. It prints the route
// (`plugin`, `dev` or `none`) on the first line and the reason on the second, and exits 0. The environment carries
// AIFY_CHANNEL_SERVICE (the service the launcher serves), AIFY_BRIDGE_DIR (its bridge) and AIFY_CHANNEL_SESSION_MCP (the
// --mcp-config it adds, base64, or empty). Any failure here prints `dev`: today's route, which needs none of this.
import { CHANNEL_SERVER, routeHere } from "./channel-route.mjs";
import { isMainModule } from "./main-module.mjs";

/** Arguments that bring MCP servers, plugins or channels this check cannot read: the plugin route is declined. */
export function namesItsOwnChannels(args) {
  return args.some((a) => /^--(mcp-config|strict-mcp-config|channels|dangerously-load-development-channels|plugin-dir)(=|$)/.test(a));
}

/** The decision for one launch, before the machine is read. */
export function routeFor({ service, args, sessionConfig, here }) {
  if (`${service}-channel` !== CHANNEL_SERVER) return { route: "dev", reason: "" };
  if (namesItsOwnChannels(args)) return { route: "dev", reason: "the arguments name MCP servers, plugins or channels themselves" };
  return here({ sessionConfigText: sessionConfig ? Buffer.from(sessionConfig, "base64").toString("utf8") : null });
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
