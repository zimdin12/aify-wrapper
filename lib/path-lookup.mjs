// Is this command name something a shell on this PATH could actually run?
//
// WHY IT EXISTS. `herdr pane run <pane> aify-env ...` TYPES a command into a shell that already
// exists; the call answers ok because the typing worked, not because the command did. So a host
// where `aify-env` is not on PATH looked identical to a healthy one for thirty seconds, and then
// failed with a message that had to offer three possible reasons because nothing had distinguished
// them. MEASURED 2026-09-16: a global install whose package link pointed into a directory the host
// no longer had left the name unresolvable, and the only symptom was the readiness timeout.
//
// THE PANE'S PATH, NOT THIS PROCESS'S. The pane inherits the server's environment, so the caller
// passes the environment it started the server with. Looking this process up instead would answer a
// question nobody asked.
//
// NOTHING IS EXECUTED. Running the candidate to see whether it runs is how a preflight turns into
// the thing it was meant to precede.

import fs from "node:fs";
import path from "node:path";

/**
 * The suffixes a bare name may carry. On Windows an npm-installed launcher is a `.cmd` shim beside
 * an extensionless script, and a lookup that knew only the bare name would refuse a working host —
 * which is the one failure a preflight must not have.
 */
function suffixes(platform, env) {
  if (platform !== "win32") return [""];
  const declared = String(env?.PATHEXT ?? env?.Pathext ?? "")
    .split(";")
    .map(entry => entry.trim())
    .filter(Boolean);
  const known = declared.length ? declared : [".COM", ".EXE", ".BAT", ".CMD"];
  // BOTH CASES. Windows spells PATHEXT in capitals and does not care about the case of a filename;
  // this check reads a directory through Node, which on a case-sensitive filesystem does. A Windows
  // layout being examined from elsewhere -- a test, a mounted volume -- would otherwise miss the
  // lowercase `.cmd` shim npm actually writes, and refuse a host that works.
  const both = [];
  for (const end of ["", ...known, ".ps1"]) {
    for (const spelling of [end, end.toLowerCase(), end.toUpperCase()]) {
      if (!both.includes(spelling)) both.push(spelling);
    }
  }
  return both;
}

/**
 * Where a shell would look, or a refusal naming what was searched.
 *
 * A NAME WITH A SEPARATOR IN IT IS NOT A PATH LOOKUP — a shell takes it as a path and so does this,
 * which is what lets a caller pass an absolute launcher and still be checked.
 */
export function resolveOnPath(name, { env = process.env, platform = process.platform, io = fs } = {}) {
  const command = String(name ?? "");
  if (!command) return { ok: false, found: null, tried: [], why: "no command name to look for" };

  const exists = candidate => {
    try {
      return io.existsSync(candidate);
    } catch {
      // An unreadable candidate is not a match.
      return false;
    }
  };

  const ends = suffixes(platform, env);
  if (command.includes("/") || (platform === "win32" && command.includes("\\"))) {
    const tried = ends.map(end => command + end);
    const found = tried.find(exists) || null;
    return found
      ? { ok: true, found, tried, why: null }
      : { ok: false, found: null, tried, why: `${command} is not a file this host has` };
  }

  const searchPath = String(env?.PATH ?? env?.Path ?? "");
  const dirs = searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const tried = [];
  for (const dir of dirs) {
    for (const end of ends) {
      const candidate = path.join(dir, command + end);
      tried.push(candidate);
      if (exists(candidate)) return { ok: true, found: candidate, tried, why: null };
    }
  }
  return {
    ok: false,
    found: null,
    tried,
    why:
      `${command} is not on the PATH the dedicated Herdr was started with, so the pane cannot run it. ` +
      (dirs.length ? `Searched ${dirs.length} director${dirs.length === 1 ? "y" : "ies"}.` : "That PATH is empty.") +
      ` Install it, or put it on PATH — a global install whose package link points at a directory that` +
      ` no longer exists fails exactly this way.`,
  };
}
