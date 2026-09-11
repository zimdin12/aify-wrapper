// Is this module the program the user actually ran?
//
// WHY IT NEEDS ITS OWN FILE. Two commands in this package guard their entry point so that importing
// them from a test stays inert. The obvious guard compares `import.meta.url` to
// `pathToFileURL(process.argv[1])` — and it is WRONG on every installation that reaches the script
// through a symlink, which includes every `npm link` and npm's own global bin shims.
//
// MEASURED ON THIS HOST, with the package linked globally:
//
//   argv[1]        C:\nvm4w\nodejs\node_modules\aify-wrapper\bin\herdr-aify.mjs   (the SYMLINK)
//   import.meta    file:///C:/Users/Administrator/projects/aify-wrapper/bin/...   (the REAL path)
//   match          false
//
// So `herdr-aify --help` exited 0 and printed nothing. Not an error, not a crash — the command was
// on PATH, ran, and did nothing at all, which is the worst way for an installed program to fail and
// the reason this guard is worth a module and a test rather than a clever line.
//
// Node resolves the main module to its real path for ESM, so resolving argv[1] the same way puts
// both sides in the same spelling.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when `metaUrl` belongs to the script named on the command line.
 *
 * FAILS CLOSED TO "NOT MAIN". A module that wrongly believes it is the program RUNS on import, which
 * for these two commands means starting a Herdr or writing to the operator's ledger from inside a
 * test. Being wrong in the other direction only costs a command that prints nothing, which is loud
 * enough to find — as it was.
 */
export function isMainModule(metaUrl, { argv = process.argv, io = fs } = {}) {
  const entry = argv?.[1];
  if (!entry || typeof metaUrl !== "string") return false;
  const candidates = [entry];
  try {
    // The real path is what `import.meta.url` already carries, so it is the one that can match.
    candidates.push(io.realpathSync(entry));
  } catch {
    // A path that cannot be resolved is not a reason to refuse; the raw form is still worth trying.
  }
  for (const candidate of candidates) {
    try {
      if (pathToFileURL(candidate).href === metaUrl) return true;
    } catch {
      // An unconvertible path simply does not match.
    }
  }
  return false;
}
