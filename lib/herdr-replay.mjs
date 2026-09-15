// Turning a recorded argv back into one line of text a pane's shell will read correctly.
//
// WHY THIS IS HARD, AND WHY IT NEARLY SHIPPED BROKEN. `herdr pane run <pane> a b c` does not spawn a
// process — it TYPES that command into whatever shell the pane is running, and this repo's own
// end-to-end proof replayed `echo RESTORED_BY_THE_PLUGIN`: one bare token, no spaces, no quotes. That
// is the single shape that cannot expose the defect. Measured against a real Herdr afterwards:
//
//     herdr pane run w1:p1 echo --flag "be terse"   ->  the pane printed   be
//                                                                          terse
//
// The argument boundary was gone. So a wrapper launched as
// `claude-aify --append-system-prompt "be terse"` would come back after a reboot as two arguments,
// silently, and the operator would get an agent configured differently from the one they started.
//
// WE DO NOT KNOW WHICH SHELL IS IN THE PANE. Measured on this host it was PowerShell; it became cmd
// when something started cmd inside it, and it can equally be bash. Quoting correctly for "the
// shell" is therefore not available. What IS available is the intersection: a double-quoted argument
// means the same thing in PowerShell, cmd and bash, PROVIDED it contains nothing any of the three
// would expand or terminate.
//
// SO THIS REFUSES RATHER THAN GUESSES. An argument outside that intersection returns a refusal
// naming the argument, and the caller reports it instead of typing something that would be wrong in
// at least one shell. A wrapper that is not restored is a disappointment; a wrapper restored with
// mangled arguments is a different agent wearing the right name.

/** Characters no shell of the three may see inside a replayed argument. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Expansion and quoting characters that mean DIFFERENT things in PowerShell, cmd and bash.
 *
 * `$` expands in bash and PowerShell, `%` in cmd, `!` in cmd with delayed expansion, a backtick is
 * PowerShell's escape and bash's substitution, and `"` ends the quoting we are relying on.
 */
const AMBIGUOUS = /["`$%!\\]/;

/** An argument that needs no quoting at all: the safest case, and the common one. */
const BARE = /^[A-Za-z0-9_@:.,=+\-\/]+$/;

/**
 * One argument, quoted for any of the three shells — or a refusal naming it.
 */
export function quoteArgument(argument) {
  const text = String(argument);
  if (text === "") return { ok: false, why: "an empty argument cannot be replayed as typed text" };
  if (CONTROL.test(text)) {
    // A newline is the dangerous one: it ends the typed line and starts a SECOND command.
    return { ok: false, why: "argument contains a control character, which would start a second command" };
  }
  if (BARE.test(text)) return { ok: true, text };
  if (AMBIGUOUS.test(text)) {
    return { ok: false, why: "argument contains a character that means different things in powershell, cmd and bash" };
  }
  return { ok: true, text: `"${text}"` };
}

/** A launcher's name: the last segment of the path it ran from, whichever separator that path uses. */
export function launcherName(launcher) {
  return String(launcher ?? "").split(/[\\/]/).pop();
}

/**
 * The argv a pane records and replays: the launcher by its NAME, not the path it happened to run from.
 *
 * MEASURED 2026-09-15, a launch typed into a Windows pane runs through `claude-aify.cmd`, which starts the
 * bash script as `C:\Users\...\.local\bin\claude-aify`. The backslash is outside what `quoteArgument` can
 * replay: the claim log held 20 such refusals since 2026-09-12, 11 of them that day, and those panes fell
 * back to Herdr's native resume of a bare `claude` session -- which is how one was saved against another agent's conversation. The path was
 * the wrong thing to replay anyway: it names a bash script with no extension, which a PowerShell or cmd
 * pane cannot run, while the name resolves to the `.cmd` shim, as those very launches show (`cmd /c
 * claude-aify.cmd`). Only a first argument that IS this wrapper is renamed; anything else is left as it is.
 */
export function replayableArgv({ wrapper, argv }) {
  if (!Array.isArray(argv) || argv.length === 0) return argv;
  const name = launcherName(wrapper);
  const [launcher, ...rest] = argv;
  return name && launcherName(launcher) === name ? [name, ...rest] : argv;
}

/** The launcher argument that says how a start treats a live instance of its agent (bin/aify-lease.sh). */
const START_INTENT_FLAG = "--aify-start-intent=";

/**
 * The argv a RESTORE replays: the recorded one, marked as an automatic start.
 *
 * A restore types the operator's earlier command back into a pane, and a pane is a terminal, so the
 * launcher would read it as a person starting the agent and REPLACE any live instance of it on this host
 * -- a managed worker that came up first, say. Nobody asked for that start just now, so it carries
 * `start`: a live instance refuses it instead. Any intent the record already carries is dropped first,
 * so a replay never holds two.
 */
export function restoreArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return argv;
  const [launcher, ...rest] = argv;
  return [launcher, `${START_INTENT_FLAG}start`, ...rest.filter((argument) => !String(argument).startsWith(START_INTENT_FLAG))];
}

/**
 * The whole command line, or a refusal.
 *
 * ALL OR NOTHING. Replaying a command with one argument dropped or split is worse than replaying
 * none of it, because the pane then holds an agent that looks right and is configured wrong.
 */
export function replayCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, text: null, why: "no argv to replay" };
  const parts = [];
  for (const argument of argv) {
    const quoted = quoteArgument(argument);
    if (!quoted.ok) return { ok: false, text: null, why: `${quoted.why}: ${JSON.stringify(String(argument))}` };
    parts.push(quoted.text);
  }
  return { ok: true, text: parts.join(" "), why: null };
}
