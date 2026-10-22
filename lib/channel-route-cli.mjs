// claude-aify asks this which channel route to take: it prints `plugin` or `dev` and always exits 0, with the
// reason on stderr. Any failure here prints `dev`, the route that works without the plugin.
import { routeHere } from "./channel-route.mjs";

let decision;
try { decision = routeHere(); } catch (error) { decision = { route: "dev", reason: `route check failed: ${error.message}` }; }
if (decision.reason) process.stderr.write(`aify channel: ${decision.reason}\n`);
process.stdout.write(`${decision.route}\n`);
