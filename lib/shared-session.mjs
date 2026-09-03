// `--shared`: let the host tier own this session's terminal, so closing the window stops ending it.
//
// THE OPERATOR'S ASK, and the headline of v0.6.2: a resident agent's TUI hosted by aify-env, watchable
// from somewhere else, surviving the terminal that started it. Today a resident runs as a child of the
// operator's shell and dies with it.
//
// THE TRICK IS THAT THE WRAPPER RELAUNCHES ITSELF. `--shared` does not serialise the runtime's command
// line and hand it to the host -- it asks the host to run THIS WRAPPER AGAIN with the same arguments
// minus the flag, and then attaches to it. Three things follow, and each is why this shape was chosen
// over building a command:
//
//   * WHAT RUNS IS EXACTLY WHAT WOULD HAVE RUN. Every wrapper does real work before it launches --
//     resolving the runtime, composing MCP flags, reaping a prior session -- and a rebuilt command
//     line would reproduce the parts somebody remembered. Re-running the wrapper reproduces all of it
//     by construction, including the parts added later.
//   * IT PASSES THE HOST'S ALLOWLIST BY BEING WHAT THE ALLOWLIST IS FOR. aify-env runs a file only if
//     it carries `HARNESS_WRAPPER_VERSION`; every wrapper carries it. Nothing has to be widened.
//   * IT IS HARNESS-AGNOSTIC. Nothing here knows what runtime the wrapper launches, so the same call
//     serves claude, codex, hermes and pi -- which matters because they are four separate templates
//     with four different launch shapes, and this is the one piece that must not be written four times.
//
// AND IT NAMES NO SERVICE OF ITS OWN. The host requires every process to have an owner, and the
// wrapper already knows which service it was rendered for. It passes that through; aify-dashboard's
// launchers will pass theirs. The service name is data here, never a branch.

/** The flag, in one place, so the parser and the stripper cannot disagree about its spelling. */
export const SHARED_FLAG = "--shared";

/**
 * Was a shared session asked for?
 *
 * EXACT MATCH ONLY. `--shared-something` is a different flag and belongs to whatever reads it, and a
 * prefix test here would swallow it silently -- the wrapper would host a session the operator did not
 * ask for and drop an argument the runtime needed.
 */
export function wantsSharedSession(args = []) {
  return (Array.isArray(args) ? args : []).some((arg) => String(arg) === SHARED_FLAG);
}

/**
 * The same arguments with the flag removed, so the relaunched wrapper does not recurse.
 *
 * EVERY OCCURRENCE, not the first. A flag passed twice is a typo, not a request to host a session
 * inside a hosted session -- and leaving the second one turns this into a fork bomb whose children
 * are agent runtimes.
 */
export function withoutSharedFlag(args = []) {
  return (Array.isArray(args) ? args : []).filter((arg) => String(arg) !== SHARED_FLAG);
}

/**
 * The body for `POST /processes` on the host tier.
 *
 * @param {object} where
 * @param {string} where.launcher absolute path to the wrapper doing the asking
 * @param {string[]} where.args its own arguments, flag already stripped
 * @param {string} where.cwd the directory the operator ran it in
 * @param {string} where.service which service this wrapper was rendered for
 * @param {string} [where.label] the agent id, when there is one
 * @returns {{body: object} | {error: string}}
 */
export function sharedStartRequest({ launcher, args = [], cwd, service, label = "" } = {}) {
  const path = String(launcher || "").trim();
  const owner = String(service || "").trim();
  // FAIL CLOSED AND SAY WHICH. Both are placeholders substituted at render time, so an empty one
  // means the launcher was rendered wrong -- and the failure would otherwise surface as a 400 from
  // the host that reads like the host is broken.
  if (!path) return { error: "a shared session needs the path of the wrapper asking for it" };
  if (!owner) return { error: "a shared session needs the service this wrapper belongs to" };

  const body = {
    service: owner,
    launcher: path,
    args: (Array.isArray(args) ? args : []).map((arg) => String(arg)),
    cwd: String(cwd || ""),
  };
  // OMITTED RATHER THAN EMPTY. A blank label is not a name, and the host renders one in the AGENT
  // column -- an empty string there reads as a process nobody owns rather than as one not yet named.
  const named = String(label || "").trim();
  if (named) body.label = named;
  return { body };
}
