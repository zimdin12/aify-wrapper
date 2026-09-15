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
// REMOVES from every managed launch (`NEVER_INHERITED` in aify-comms' launch_env.py). `CLAUDECODE` is not
// one: a host started inside Claude Code passes it on and nothing strips it.
//   AIFY_AGENT_LEASE            exported by every launcher that holds its agent's lease
//   CLAUDE_CODE_CHILD_SESSION   set by Claude Code in everything it runs; it is how the incident's shell was known
//
// A MARKER CAN STILL REACH A LAUNCH A HOST COMPOSED, and what is dropped is split by that. An aify-env older
// than the one that applies the service's unset list, started inside a Claude Code session, hands its markers
// to every worker it launches. That launch names its agent on the command line and carries its mode, role,
// terminal and model in the environment. An external review (2026-09-15) reproduced the first version of this
// dropping all of them: the worker lost `managed`, its terminal made it read as a person, and its named start
// replaced the live instance it was meant to leave alone. So:
//   - what a session RESUMES and how it was told to START is never inherited: a launch that means to resume
//     says `--resume`, and a start intent belongs to the start that was asked for;
//   - who a session IS, and how its host runs it, is dropped only when the command names no agent.
// Dropping a start intent can only make a start more careful: with none, a managed launch only starts.
//
// bin/aify-inherited-session.sh is the shell half and carries the same lists; a test holds them equal.

/** Present and non-empty, either one says: this environment is a running agent session's own. */
export const SESSION_MARKERS = Object.freeze(["AIFY_AGENT_LEASE", "CLAUDE_CODE_CHILD_SESSION"]);

/** The conversation a session holds and the intent it was started with: never handed to another start. */
export const NEVER_INHERITED_BY_A_START = Object.freeze([
  "AIFY_START_INTENT",
  "AIFY_SESSION_HANDLE",
  "CLAUDE_SESSION_ID",
  "CODEX_THREAD_ID",
  "HERMES_SESSION_ID",
  "HERMES_SESSION",
  "PI_SESSION_ID",
  "OMP_SESSION_ID",
  "AIFY_PI_SESSION_ID",
]);

/**
 * Who a session is and how its host runs it: dropped only for a command that names no agent, which would
 * otherwise become this session's agent. A command that names one keeps them, because a host that names its
 * agent also put these here. The markers are in neither list: `AIFY_AGENT_LEASE` is what lets a launch run
 * inside its own agent's live instance be refused rather than kill that instance.
 */
export const NAMES_THE_SESSION = Object.freeze([
  "AIFY_AGENT_ID",
  "AIFY_COMMS_AGENT_ID",
  "AIFY_AGENT_ROLE",
  "AIFY_COMMS_AGENT_ROLE",
  "AIFY_AGENT_CWD",
  "AIFY_SESSION_MODE",
  "AIFY_TERMINAL_ID",
  "AIFY_MANAGED_VIA_WRAPPER",
  "AIFY_MANAGED_MODEL",
  "AIFY_MANAGED_EFFORT",
  "AIFY_HERMES_FRESH_CONTEXT",
]);

/**
 * PURE. `env` with no trace of any agent session: the markers, both lists, and `CLAUDECODE`.
 *
 * For a process that is never an agent session itself and whose children are started by a person -- a
 * Herdr server, whose panes are new terminals. `CLAUDECODE` goes too, which a launcher's own check cannot
 * use (see the header): nothing started in a pane is inside Claude Code. Compared without case, because
 * Windows reads `aify_agent_id` as the same variable.
 */
export function withoutAgentSession(env = {}) {
  const drop = new Set([...SESSION_MARKERS, ...NEVER_INHERITED_BY_A_START, ...NAMES_THE_SESSION, "CLAUDECODE"]);
  return Object.fromEntries(Object.entries(env || {}).filter(([name]) => !drop.has(name.toUpperCase())));
}
