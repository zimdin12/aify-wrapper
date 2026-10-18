#!/usr/bin/env node
// Claude Code's UserPromptSubmit hook: adds what the registry's turn-start services say to the turn that is starting.
// The logic is lib/turn-start.mjs; this file is its I/O. It ALWAYS exits 0. Everything after module load is bounded by
// one absolute due time: stdin, the registry and the credentials are read asynchronously against it, the answer closes
// at it with what had arrived, and a backstop just after it exits whatever is still pending.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCredential } from "../lib/credential-file.mjs";
import { hostIsWsl, machineIdFor } from "../lib/machine-id.mjs";
import { parseRegistry, TURN_START_DEADLINE_MS } from "../lib/registry.mjs";
import { hookOutput, runTurnStart, turnStartTargets } from "../lib/turn-start.mjs";

const startedAt = Date.now();
const dueAt = startedAt + TURN_START_DEADLINE_MS;
const remaining = () => dueAt - Date.now();
// The backstop: whatever is still pending just after the due time is abandoned, and the turn goes on without it.
setTimeout(() => process.exit(0), TURN_START_DEADLINE_MS + 100).unref();

/** `promise`'s value, or `fallback` if the due time comes first. */
function byDue(promise, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, remaining())); })])
    .finally(() => clearTimeout(timer));
}

/** The hook's JSON from stdin, or null when it is incomplete or not JSON before the deadline. */
function readHookInput() {
  return new Promise((resolve) => {
    let raw = "";
    const timer = setTimeout(() => resolve(null), Math.max(0, remaining()));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

async function main() {
  const agentId = String(process.env.AIFY_AGENT_ID || "").trim();
  if (!agentId) return "";
  const input = await readHookInput();
  const sessionKey = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionKey) return "";
  const text = await byDue(fs.promises.readFile(process.env.AIFY_SERVICE_REGISTRY || path.join(os.homedir(), ".aify", "services.json"), "utf8")
    .catch(() => null), null);
  if (text === null) return "";
  const parsed = parseRegistry(text);
  if (!parsed.ok) return "";
  const targets = turnStartTargets(parsed.registry);
  if (!targets.length) return "";
  const request = {
    agentId,
    cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
    machineId: machineIdFor({ platform: process.platform, hostname: os.hostname(), env: process.env, isWsl: hostIsWsl() }),
    sessionKey,
  };
  const { text: added } = await runTurnStart({
    targets, request, keyFor: (ref) => readCredential(ref), fetchImpl: fetch, startedAt, dueAt,
  });
  return hookOutput(added);
}

main()
  .catch(() => "")
  .then((output) => {
    if (output) process.stdout.write(output, () => process.exit(0));
    else process.exit(0);
  });
