// What an environment inherited from a RUNNING AGENT SESSION carries, and how to tell that it did.
//
// THE INCIDENT, 2026-09-15. A Herdr server had been started from inside a Claude Code session running as
// comms-tech-lead, so its environment held `AIFY_AGENT_ID=comms-tech-lead` and that conversation's
// `CLAUDE_SESSION_ID`, and every pane shell it opened inherited both. The operator typed a bare
// `claude-aify` into a new pane. The launcher took its identity from the environment, started as
// comms-tech-lead, read a person at a terminal as an explicit start, and replaced -- killed -- the live
// comms-tech-lead. The operator then registered that window as general-manager, and two agents held one
// conversation.
//
// TWO NAMES MARK A RUNNING SESSION'S OWN ENVIRONMENT, and only these two, because each is one the service
// REMOVES from every managed launch (`NEVER_INHERITED` in aify-comms' launch_env.py). A marker a launch
// composed for a worker could also carry would make that worker forget the identity and mode its host gave
// it: `CLAUDECODE` is one, since a host started inside Claude Code passes it on and nothing strips it.
//   AIFY_AGENT_LEASE            exported by every launcher that holds its agent's lease
//   CLAUDE_CODE_CHILD_SESSION   set by Claude Code in everything it runs; it is how the incident's shell was known
//
// bin/aify-inherited-session.sh is the shell half and carries the same two lists; a test holds them equal.

/** Present and non-empty, either one says: this environment is a running agent session's own. */
export const SESSION_MARKERS = Object.freeze(["AIFY_AGENT_LEASE", "CLAUDE_CODE_CHILD_SESSION"]);

/**
 * What names that session -- who it is, how it was started, which conversation it holds -- and so must not
 * name a start made from inside it. The markers are not here: `AIFY_AGENT_LEASE` is what lets a launch run
 * inside its own agent's live instance be refused rather than kill that instance.
 */
export const SESSION_CARRIERS = Object.freeze([
  "AIFY_AGENT_ID",
  "AIFY_COMMS_AGENT_ID",
  "AIFY_AGENT_ROLE",
  "AIFY_COMMS_AGENT_ROLE",
  "AIFY_AGENT_CWD",
  "AIFY_SESSION_MODE",
  "AIFY_SESSION_HANDLE",
  "AIFY_START_INTENT",
  "AIFY_TERMINAL_ID",
  "AIFY_MANAGED_VIA_WRAPPER",
  "AIFY_MANAGED_MODEL",
  "AIFY_MANAGED_EFFORT",
  "AIFY_HERMES_FRESH_CONTEXT",
  "CLAUDE_SESSION_ID",
  "CODEX_THREAD_ID",
  "HERMES_SESSION_ID",
  "HERMES_SESSION",
  "PI_SESSION_ID",
  "OMP_SESSION_ID",
  "AIFY_PI_SESSION_ID",
]);

/**
 * PURE. `env` with no trace of any agent session: the markers, the carriers, and `CLAUDECODE`.
 *
 * For a process that is never an agent session itself and whose children are started by a person -- a
 * Herdr server, whose panes are new terminals. `CLAUDECODE` goes too, which a launcher's own check cannot
 * use (see the header): nothing started in a pane is inside Claude Code. Compared without case, because
 * Windows reads `aify_agent_id` as the same variable.
 */
export function withoutAgentSession(env = {}) {
  const drop = new Set([...SESSION_MARKERS, ...SESSION_CARRIERS, "CLAUDECODE"]);
  return Object.fromEntries(Object.entries(env || {}).filter(([name]) => !drop.has(name.toUpperCase())));
}
