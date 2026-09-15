// The watch every claim starts: when the agent's instance ends, however it ends, nothing it started keeps running.
//
// THE OPERATOR'S RULE (2026-09-15): "orphan processes suck", after closing everything and finding a hermes
// gateway still up with no agent behind it. A launcher's own exit releases the lease and stops what it
// attached, but a launcher that is KILLED runs no exit path at all -- a closed terminal, a `taskkill`, a
// host tier stopped hard. Until now the next claim of that agent was the only collector, and an agent
// nobody starts again kept its leftovers for days.
//
// So a claim starts one small process OUTSIDE the launcher's tree (detached, its parent the claim helper
// that exits at once), which waits for the instance to end and then runs `AgentLease.collect`: everything
// attached, and every process the instance left running, stopped. It exits as soon as the record names
// another instance or none, so a replace or a clean release ends it too.
//
// A watch that is itself killed collects nothing; the next claim of the agent still does, and aify-comms'
// doctor still reports what is left. It is a second line, not the only one.

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

/** How often the watch looks at its instance, and how many looks between checks of who holds the lease. */
const WATCH_POLL_MS = 1_000;
const WATCH_RECHECK_EVERY = 5;
/** How many times a collect that could not finish is retried before the watch leaves it to the next claim. */
const WATCH_COLLECT_ATTEMPTS = 5;
const WATCH_RETRY_MS = 2_000;

/**
 * Wait for `instance` to end, then collect it. Every dependency is injected so the loop is testable with no
 * processes and no clock.
 * @returns {Promise<{collected: boolean, reason?: string, stopped: object[]}>}
 */
export async function watchInstance({ lease, instance, isAlive, sleep, pollMs = WATCH_POLL_MS, recheckEvery = WATCH_RECHECK_EVERY, attempts = WATCH_COLLECT_ATTEMPTS }) {
  for (let tick = 1; ; tick += 1) {
    // A pid that is alive can still be somebody else's by now, so every few looks the watch asks who it is.
    const state = tick % recheckEvery === 0 || !isAlive(instance) ? lease.holderState(instance) : "ours";
    if (state === "not-the-holder") return { collected: false, reason: "not-the-holder", stopped: [] };
    if (state === "gone" || state === "reused") return collectWithRetries({ lease, instance, sleep, attempts });
    await sleep(pollMs);
  }
}

async function collectWithRetries({ lease, instance, sleep, attempts }) {
  let result = { collected: false, reason: "not-attempted", stopped: [] };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = lease.collect({ instance });
    if (result.collected || result.reason === "not-the-holder" || result.reason === "still-running") return result;
    await sleep(WATCH_RETRY_MS);
  }
  return result;
}

/**
 * Start the watch for `instance`, detached from the launcher so that killing the launcher's tree does not
 * kill it. Its working directory is node's own, so it never holds a directory somebody wants to delete.
 * `AIFY_AGENT_LEASE_WATCH=0` starts none; the suites set it for launchers whose lease they judge directly.
 */
export function startWatch({ agentId, instance, env = process.env, script, spawn = nodeSpawn, execPath = process.execPath }) {
  if (String(env.AIFY_AGENT_LEASE_WATCH ?? "").trim() === "0") return null;
  const child = spawn(execPath, [script, "watch", "--agent", agentId, "--instance", String(instance), "--pid", String(instance)], {
    cwd: path.dirname(execPath),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // The watch is not part of the instance: an inherited lease would make it read as nested in it.
    env: { ...env, AIFY_AGENT_LEASE: "" },
  });
  child.unref?.();
  return child;
}
