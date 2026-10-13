// What a hermes launch for an agent leaves behind from the previous one, found and ended on every platform.
//
// The launcher's kill-prior was `pkill`/`pgrep`, gated on `command -v pkill`. Git for Windows ships neither, so on
// Windows, the only production host, the whole block was skipped: a relaunched hermes agent kept its previous
// `hermes-managed-host.js run <agent>` delivery loop running and heartbeating, and a dead agent read online. This
// reads the process table once, through the module that owns it, and ends what it finds through `killTree`.
//
// A PROCESS IS MATCHED BY WHAT IT RUNS, NOT BY WHAT ITS COMMAND LINE MENTIONS (review of 39d61c5): an editor, a log
// tail or a script given the loop's text as an argument is not the loop. And another agent's processes, as its lease
// names them, are never targets and never inside a kill, whatever they run.

import { AgentLease } from "./agent-lease.mjs";
import { ancestors, descendants, hostsOf, killTree, processTable } from "./process-identity.mjs";

/** A command line as its argv, quotes removed. PURE. Close enough for the two shapes matched below, which a launcher
 *  writes with no quote inside an argument. */
function argv(commandLine) {
  return (String(commandLine || "").match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^(["'])(.*)\1$/, "$2"));
}

const base = (token) => String(token || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");

/** `[nohup] node [node options] <dir>/hermes-managed-host.js run <agentId>`, the launcher's loop. PURE. */
function isDeliveryLoop(commandLine, agentId) {
  const args = argv(commandLine);
  let at = base(args[0]) === "nohup" ? 1 : 0;
  if (base(args[at]) !== "node") return false;
  at += 1;
  while (args[at]?.startsWith("-")) at += 1;
  return base(args[at]) === "hermes-managed-host.js" && args[at + 1] === "run" && args[at + 2] === agentId;
}

/** A hermes TUI (`hermes … --tui … --resume <resumeId>`), the launcher's visible run. PURE. */
function isResumedTui(commandLine, resumeId) {
  const args = argv(commandLine);
  const tui = args.indexOf("--tui");
  const resume = args.indexOf("--resume");
  return Boolean(resumeId) && tui > 0 && args.slice(0, tui).some((token) => base(token) === "hermes")
    && resume > 0 && args[resume + 1] === resumeId;
}

/**
 * PURE. The pids of the previous launch's delivery loop for `agentId`, and of the visible TUI resuming `resumeId`
 * when one is given, outermost first. Never one of `exclude` (this launch's own loop) or anything it started, never
 * `self` or above it, and never another agent's process (`others`) or one hosting it.
 */
export function priorHermesRuns(table, { agentId, resumeId = "", exclude = [], self = process.pid, others = new Set() } = {}) {
  if (!table || !agentId) return [];
  const spared = new Set([...ancestors(self, table), ...hostsOf(others, table)]);
  for (const pid of [...exclude, ...others]) {
    spared.add(pid);
    for (const below of descendants(pid, table)) spared.add(below);
  }
  const found = [...table.values()]
    .filter((row) => !spared.has(row.pid) && (isDeliveryLoop(row.commandLine, agentId) || isResumedTui(row.commandLine, resumeId)))
    .map((row) => row.pid);
  // `nohup node hermes-managed-host.js run X` matches twice, parent and child; ending the parent's tree ends both. Only
  // a pid really inside another target's tree is dropped: a parent id now held by a newer process is not its parent.
  return found.filter((pid) => !found.some((other) => other !== pid && descendants(other, table).includes(pid)));
}

/** Every pid another agent's lease on this host names, alive as recorded. */
function otherAgents(agentId, table) {
  try {
    return new AgentLease({ agentId }).otherAgentsProcesses(table);
  } catch {
    return new Set();
  }
}

/** End the previous launch's runs. Returns how many were ended; an unreadable table ends nothing. */
export function reapPriorHermesRuns({ agentId, resumeId = "", exclude = [], table = processTable({ commands: true }), kill = killTree,
  others = otherAgents(agentId, table) } = {}) {
  if (!table) return 0;
  const targets = priorHermesRuns(table, { agentId, resumeId, exclude, others });
  // The kill gets the same exclusions the selection used, so its own tree walk cannot reach this launch's loop or
  // another agent's processes either.
  const spare = exclude.flatMap((pid) => [pid, ...descendants(pid, table)]);
  for (const pid of targets) kill(pid, { table, spare, boundaries: [...others] });
  return targets.length;
}
