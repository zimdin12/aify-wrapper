// A channel server configured the way the service installer leaves one, for a test that runs a rendered claude-aify.
//
// SINCE THE CHANNEL ROUTE CHECK (2026-10-22) claude-aify refuses (78) to start a session no message could reach: no
// `aify-comms-channel` server in the user's ~/.claude.json and no admitted channel plugin. A fixture that configures
// neither measures that refusal, not what it was written for -- which is how the launcher tests that skip on Windows
// went red on Linux unseen.

import fs from "node:fs";
import path from "node:path";

/** Write `<bridge>/claude-channel.js` and point `<home>/.claude.json`'s `aify-comms-channel` at it. */
export function configureChannel(home, bridge) {
  const channel = path.join(bridge, "claude-channel.js");
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(channel, "// the channel\n");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "aify-comms-channel": { command: "node", args: [channel] } } }));
}
