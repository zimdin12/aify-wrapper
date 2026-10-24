#!/usr/bin/env node
// Reset starts a new lifetime, but retains the agent's port/key allocation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [stdio, agentId] = process.argv.slice(2);
try {
  const { sanitizeAgentId } = await import(pathToFileURL(path.join(stdio, "hermes-endpoint.js")));
  const { GatewayMarkerStore } = await import(pathToFileURL(path.join(stdio, "hermes-gateway-marker.mjs")));
  const id = sanitizeAgentId(agentId);
  if (id) {
    const dir = process.env.TEMP || process.env.TMP || os.tmpdir();
    for (const [root, kind] of [[dir, "session"], [dir, "gateway"], [os.tmpdir(), "loop-ready"]]) {
      fs.rmSync(path.join(root, `aify-hermes-${kind}-${id}`), { force: true });
    }
    new GatewayMarkerStore().clear(id);
  }
} catch (err) {
  const reason = String(err?.message || err).replace(/[\r\n]+/g, " ");
  console.error(`[hermes-aify] WARN: could not clear ${agentId}'s markers: ${reason}`);
}
