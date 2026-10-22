// The aify-channel plugin, rendered for one bridge: a local marketplace `aify-local` holding one plugin whose only
// server runs aify-comms' claude-channel-plugin.mjs straight from that bridge.
//
// RENDERED, NOT SHIPPED, because the server's path is this host's bridge. Claude starts it as `node <entry>`, so the
// channel's parent is Claude itself, as the user-scope server's is (docs/evidence/2026-10-22-channel-plugin, case A),
// and its orphan guard and liveness gate watch the right process. The server key stays `aify-comms-channel`; Claude
// namespaces it as `plugin:aify-channel:aify-comms-channel`.

import path from "node:path";

import { OUR_ENTRY } from "./channel-policy.mjs";
import { CHANNEL_SERVER, PLUGIN_ENTRY } from "./channel-route.mjs";

/** Where the installer renders the marketplace. */
export const marketplaceDir = (home) => path.join(home, ".aify", "claude-plugins", OUR_ENTRY.marketplace);

/** The marketplace's files, relative to its directory, for the bridge at `bridgeDir`. */
export function renderMarketplace(bridgeDir) {
  const marketplace = {
    name: OUR_ENTRY.marketplace,
    owner: { name: "aify" },
    plugins: [{ name: OUR_ENTRY.plugin, source: `./plugins/${OUR_ENTRY.plugin}`, description: "aify-comms' channel, without the development-channels prompt" }],
  };
  const plugin = {
    name: OUR_ENTRY.plugin,
    version: "1.0.0",
    description: "Delivers aify-comms messages into a claude-aify session as channel events.",
    mcpServers: { [CHANNEL_SERVER]: { command: "node", args: [path.join(bridgeDir, PLUGIN_ENTRY)] } },
  };
  return {
    [path.join(".claude-plugin", "marketplace.json")]: `${JSON.stringify(marketplace, null, 2)}\n`,
    [path.join("plugins", OUR_ENTRY.plugin, ".claude-plugin", "plugin.json")]: `${JSON.stringify(plugin, null, 2)}\n`,
  };
}
