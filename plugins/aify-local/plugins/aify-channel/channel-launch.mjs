// Which channel script the plugin runs, and with what endpoint: a pure decision, so it is tested without
// a filesystem or a process (tests/the-channel-plugin-runs-comms-installed-channel.test.js).

import path from "node:path";

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/** comms' endpoint from the registry text, or "" when the registry has no usable aify-comms entry. */
function registryEndpoint(text) {
  if (!nonEmpty(text)) return "";
  try {
    const entry = JSON.parse(text)?.services?.["aify-comms"];
    return nonEmpty(entry?.endpoint) ? entry.endpoint.trim() : "";
  } catch {
    return "";
  }
}

/**
 * @param {{env: Record<string,string|undefined>, home: string, exists: (file: string) => boolean, registryText: string|null}} io
 * @returns {{ok: true, script: string, env: Record<string,string|undefined>} | {ok: false, reason: string}}
 */
export function channelLaunch({ env, home, exists, registryText }) {
  const bridge = nonEmpty(env.AIFY_BRIDGE_DIR) ? env.AIFY_BRIDGE_DIR
    : path.join(nonEmpty(env.AIFY_HOME) ? env.AIFY_HOME : path.join(home, ".aify-comms"), "mcp", "stdio");
  const script = path.join(bridge, "claude-channel.js");
  if (!exists(script)) return { ok: false, reason: `aify-comms' channel is not installed at ${script}` };
  const endpoint = nonEmpty(env.CLAUDE_MCP_SERVER_URL) ? env.CLAUDE_MCP_SERVER_URL
    : nonEmpty(env.AIFY_SERVER_URL) ? env.AIFY_SERVER_URL : registryEndpoint(registryText);
  if (!endpoint) return { ok: false, reason: "no aify-comms endpoint: none in the environment, none in ~/.aify/services.json" };
  return { ok: true, script, env: { ...env, AIFY_SERVER_URL: endpoint, CLAUDE_MCP_SERVER_URL: endpoint } };
}
