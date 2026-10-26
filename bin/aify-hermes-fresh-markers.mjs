#!/usr/bin/env node
// Reset starts a new lifetime: clear the agent's session and loop-ready markers so it starts a fresh conversation.
// (The gateway markers this also cleared left with comms' gateway start in 0.9.10; `gateway` stays in the list so a
// marker an older bridge wrote is still cleared.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [stdio, agentId] = process.argv.slice(2);
try {
  const { sanitizeAgentId } = await import(pathToFileURL(path.join(stdio, "hermes-endpoint.js")));
  const id = sanitizeAgentId(agentId);
  if (id) {
    const dir = process.env.TEMP || process.env.TMP || os.tmpdir();
    for (const [root, kind] of [[dir, "session"], [dir, "gateway"], [os.tmpdir(), "loop-ready"]]) {
      fs.rmSync(path.join(root, `aify-hermes-${kind}-${id}`), { force: true });
    }
  }
} catch (err) {
  const reason = String(err?.message || err).replace(/[\r\n]+/g, " ");
  console.error(`[hermes-aify] WARN: could not clear ${agentId}'s markers: ${reason}`);
}
