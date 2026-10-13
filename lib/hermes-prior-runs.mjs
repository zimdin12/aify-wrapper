// What a hermes launch for an agent leaves behind from the previous one, found and ended on every platform.
//
// The launcher's kill-prior was `pkill`/`pgrep`, gated on `command -v pkill`. Git for Windows ships neither, so on
// Windows, the only production host, the whole block was skipped: a relaunched hermes agent kept its previous
// `hermes-managed-host.js run <agent>` delivery loop running and heartbeating, and a dead agent read online. This
// reads the process table once, through the module that owns it, and ends what it finds through `killTree`.

import { ancestors, descendants, killTree, processTable } from "./process-identity.mjs";

const literal = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * PURE. The pids of the previous launch's delivery loop for `agentId`, and of the visible TUI resuming `resumeId`
 * when one is given, outermost first. The agent id is matched whole: `run pc` never matches `run pc-manager`.
 * Never one of `exclude` (this launch's own loop) or anything it started, and never `self` or above it.
 */
export function priorHermesRuns(table, { agentId, resumeId = "", exclude = [], self = process.pid } = {}) {
  if (!table || !agentId) return [];
  const loop = new RegExp(`hermes-managed-host\\.js["']?\\s+run\\s+["']?${literal(agentId)}["']?(?=\\s|$)`);
  const tui = resumeId ? new RegExp(`--tui\\s+--resume\\s+["']?${literal(resumeId)}["']?(?=\\s|$)`) : null;
  const spared = new Set(ancestors(self, table));
  for (const pid of exclude) {
    spared.add(pid);
    for (const below of descendants(pid, table)) spared.add(below);
  }
  const found = [...table.values()]
    .filter((row) => !spared.has(row.pid) && (loop.test(row.commandLine || "") || (tui && tui.test(row.commandLine || ""))))
    .map((row) => row.pid);
  const matched = new Set(found);
  // `nohup node hermes-managed-host.js run X` matches twice, parent and child; ending the parent's tree ends both.
  return found.filter((pid) => !matched.has(table.get(pid)?.ppid));
}

/** End the previous launch's runs. Returns how many were ended; an unreadable table ends nothing. */
export function reapPriorHermesRuns({ agentId, resumeId = "", exclude = [], table = processTable({ commands: true }), kill = killTree } = {}) {
  if (!table) return 0;
  const targets = priorHermesRuns(table, { agentId, resumeId, exclude });
  for (const pid of targets) kill(pid, { table });
  return targets.length;
}
