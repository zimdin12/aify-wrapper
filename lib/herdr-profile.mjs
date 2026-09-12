// The private Herdr profile one `herdr-aify` invocation runs in, and the two environments that
// profile implies.
//
// WHY ISOLATION IS THE WHOLE FEATURE. `herdr-aify` must not attach to, disturb or inherit the
// operator's ordinary Herdr. Measured on Windows against Herdr 0.9.0: `XDG_CONFIG_HOME` and
// `XDG_STATE_HOME` are honoured before the platform fallback, and `session.json` is written under
// the CONFIG root -- so redirecting the state root alone would have left a dedicated instance
// writing into the operator's real session file, which is the one mistake that would be invisible
// until it had already happened.
//
// TWO ENVIRONMENTS, AND THE SECOND ONE IS EASY TO FORGET. Children of a pane inherit the XDG roots,
// which was also measured. So the isolation that is right for Herdr itself is wrong for every agent
// started inside it: an agent inheriting these would keep its state in a directory that is deleted
// when the invocation ends. `agentEnv` is the undo, and it exists so that "clear them for the
// agents" is a function somebody calls rather than a line in a document somebody remembers.

import path from "node:path";

/** Inherited Herdr wiring that must never reach a dedicated invocation or an agent inside it. */
const HERDR_INHERITED = ["HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Where this invocation's Herdr keeps its config, its state and its socket.
 *
 * DERIVED FROM THE INVOCATION, like the instance layout beside it and for the same reason: a
 * configurable path here would be a way to point a dedicated Herdr at the operator's real profile.
 */
export function profilePaths({ profileRoot, invocation, platform = process.platform }) {
  if (!path.isAbsolute(String(profileRoot || ""))) throw new Error("herdr_profile: absolute profile root required");
  if (!UUID.test(String(invocation || ""))) throw new Error("herdr_profile: invocation must be a v4 uuid");
  const root = path.join(path.resolve(profileRoot), "invocations", invocation);
  return Object.freeze({
    root,
    configHome: path.join(root, "herdr-config"),
    stateHome: path.join(root, "herdr-state"),
    // A FILE PATH ON EVERY PLATFORM, including Windows. This was a `\\.\pipe\...` named pipe, by
    // analogy with the instance layout beside it, and Herdr refused it: the server exited 1 with
    // `Os { code: 5, kind: PermissionDenied }` and the launcher reported only "exited before it was
    // ready". Herdr uses a filesystem socket on Windows too -- its own error names
    // `...config\herdr\herdr.sock` -- and a file path under the invocation root was measured
    // starting cleanly where the pipe could not. The analogy was the mistake; aify-env's endpoints
    // are aify-env's business, and Herdr's are Herdr's.
    socketPath: path.join(root, "herdr-tui.sock"),
  });
}

/**
 * The ONE profile plain `herdr-aify` uses, every time.
 *
 * WHY IT IS STABLE WHERE THE INVOCATION ONE IS NOT. The two modes want opposite things from a
 * profile, and giving both the per-invocation one is what broke the plain mode. The operator:
 * "ordinary herdr-aify should remember previous instance agents like ordinary herdr does, that
 * herdr-aify env is the one that really acts differently. herdr-aify is like ordinary, but supports
 * our -aify stuff so they could be saved etc."
 *
 * A FRESH PROFILE HAS NOTHING TO RESTORE. Herdr keeps its session in the config root, so a new UUID
 * per launch meant every plain launch was a first launch: they started a resident `claude-aify`,
 * detached, ran `herdr-aify` again, and neither the space nor the agent came back -- while
 * aify-comms still showed the agent online, because the process was still running with nothing left
 * pointing at it.
 *
 * IT IS STILL NOT THE OPERATOR'S ORDINARY HERDR. Separate XDG roots and a separate socket, so this
 * is a second, aify-flavoured Herdr that persists -- not an attachment to theirs.
 */
export function residentPaths({ profileRoot }) {
  if (!path.isAbsolute(String(profileRoot || ""))) throw new Error("herdr_profile: absolute profile root required");
  const root = path.join(path.resolve(profileRoot), "resident");
  return Object.freeze({
    root,
    configHome: path.join(root, "herdr-config"),
    stateHome: path.join(root, "herdr-state"),
    socketPath: path.join(root, "herdr-tui.sock"),
  });
}

/**
 * The config a dedicated instance's Herdr starts with, and where it goes.
 *
 * WHY IT EXISTS. The profile is fresh every invocation, so Herdr ran its first-launch flow EVERY
 * TIME: a page explaining what Herdr is, then an integrations page, each needing a keypress before
 * the operator reached the thing they actually asked for. Measured from a real run: the whole of the
 * state Herdr keeps for that is one line, `onboarding = false`, written to `config.toml` in its
 * config root — so seeding it is the entire fix, and it is Herdr's own spelling rather than a guess.
 *
 * NEVER OVERWRITES. Written with `wx`, so a config that somehow already exists in this invocation is
 * left exactly as it is. An isolated profile means this can only ever be the invocation's own file,
 * never the operator's — that separation is what `profilePaths` is for.
 */
export function dedicatedHerdrConfig(paths) {
  return Object.freeze({
    file: path.join(paths.configHome, "herdr", "config.toml"),
    // A TOML file's line ending is its own business, but a literal newline in a source string is not
    // something this repo puts through a shell, so it is spelled rather than typed.
    contents: `onboarding = false${String.fromCharCode(10)}`,
  });
}

/**
 * The environment the dedicated Herdr server is started with.
 *
 * IT CLEARS BEFORE IT SETS. A `herdr-aify` launched from inside an ordinary Herdr pane inherits that
 * pane's `HERDR_SOCKET_PATH` and ids; leaving them would point the new server's own CLI calls at the
 * parent Herdr, so the dedicated instance would quietly drive the operator's real one.
 */
export function herdrServerEnv(base, paths) {
  const env = { ...base };
  for (const name of HERDR_INHERITED) delete env[name];
  env.XDG_CONFIG_HOME = paths.configHome;
  env.XDG_STATE_HOME = paths.stateHome;
  env.HERDR_SOCKET_PATH = paths.socketPath;

  // THE UNDO TRAVELS WITH THE ISOLATION. Everything started inside this Herdr inherits these roots,
  // including agents, so the wrapper needs to know what the host had before it can put it back. The
  // markers are written here because here is the only place that still knows.
  env[ISOLATED_MARKER] = "1";
  for (const [name, marker] of Object.entries(HOST_XDG_MARKERS)) {
    if (Object.prototype.hasOwnProperty.call(base, name)) env[marker] = base[name];
    else delete env[marker];
  }

  // A DEDICATED INSTANCE GETS ITS OWN PANE LEDGER. Two Herdr servers sharing `~/.aify/herdr/panes.json`
  // means whichever runs a restore first prunes away every record belonging to the other, because a
  // prune keys on the labels of the panes IT can see.
  env.AIFY_HERDR_LEDGER = path.join(paths.root, "panes.json");
  return env;
}

/**
 * The names the wrapper reads to put an AGENT's environment back the way the host had it.
 *
 * WHY THIS IS CARRIED RATHER THAN COMPUTED. The isolation has to reach Herdr and stop at the agents
 * started inside it, and the thing that starts an agent is the operator typing `claude-aify` into a
 * pane — a shell script, not anything this module can wrap. So the undo cannot be a function here;
 * it has to be data the wrapper can read, which is what these are.
 *
 * THERE WAS A FUNCTION HERE AND IT HAD NO CALLER. `agentEnv` looked like the mitigation and was
 * never invoked from any production path, while HERDR.md stated the mitigation as done. An agent
 * inheriting `XDG_STATE_HOME` writes into a directory that is deleted when the invocation ends —
 * `codex-aify` puts its app-server log there — so the claim was not merely unproven, it was false.
 *
 * ABSENT MEANS ABSENT. A host that never set `XDG_CONFIG_HOME` must leave the agent without one, so
 * the marker is only written when the host really had a value; presence is the signal, never "".
 */
export const HOST_XDG_MARKERS = Object.freeze({
  XDG_CONFIG_HOME: "AIFY_HERDR_HOST_XDG_CONFIG_HOME",
  XDG_STATE_HOME: "AIFY_HERDR_HOST_XDG_STATE_HOME",
});

/** The flag a wrapper checks before restoring anything, so an ordinary launch is untouched. */
export const ISOLATED_MARKER = "AIFY_HERDR_ISOLATED";

/**
 * The argv that starts the dedicated aify-env in the first space.
 *
 * `--instance-context` MUST BE THE FIRST OPTION. aify-env's own reader refuses the flag unless
 * `args[0]` starts with `-`, refuses a relative path, and refuses it alongside `--force`. Building
 * the argv here rather than at the call site keeps that agreement in one place.
 */
export function dedicatedEnvArgv(contextFile) {
  if (!path.isAbsolute(String(contextFile || ""))) throw new Error("herdr_profile: absolute context path required");
  return ["--instance-context", contextFile];
}
