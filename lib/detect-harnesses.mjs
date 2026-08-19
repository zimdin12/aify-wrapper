// Which harnesses this machine has, decided from an injected lookup.
//
// Pure: filenames in, client names out; a lookup function in, rows out. The caller owns the directory
// read and the PATH probe. That keeps the decision testable without a machine that happens to have
// four coding-agent CLIs installed, and keeps the tests from measuring the developer's laptop.
//
// The client list is DERIVED from the wrapper templates present rather than written down. A list you
// must remember to update is a defect with a delay on it: adding wrappers/gemini-aify.sh.in should
// make gemini installable, not make gemini installable once somebody also edits an array.

/** `<client>-aify.sh.in` is the only filename shape that declares a launcher. */
const TEMPLATE_PATTERN = /^([a-z0-9][a-z0-9-]*)-aify\.sh\.in$/;

/**
 * Client names derived from a directory listing of `wrappers/`.
 * Sorted, so the same directory always yields the same order.
 *
 * @param {string[]} filenames
 * @returns {string[]}
 */
export function harnessClientsFrom(filenames) {
  const clients = (filenames ?? [])
    .map((name) => TEMPLATE_PATTERN.exec(String(name ?? "")))
    .filter(Boolean)
    .map((match) => match[1]);
  return [...new Set(clients)].sort();
}

/**
 * One row per client, saying whether its runtime is present.
 *
 * The probe asks for the RUNTIME (`claude`), never the launcher (`claude-aify`). Asking for the
 * launcher would let a previously-installed wrapper prove the presence of a harness that has since
 * been uninstalled, so every reinstall would keep reinstalling launchers for runtimes that are gone.
 *
 * FAILS CLOSED. A lookup that throws, or returns nothing, means "not found" — never "found". A probe
 * that could not answer has not said yes, and installing a launcher for a runtime that may not exist
 * produces a command that fails at the moment somebody tries to start an agent with it.
 *
 * @param {{clients: string[], lookup: (command: string) => string|null}} options
 * @returns {{client: string, command: string, found: boolean, path: string|null}[]}
 */
export function detectHarnesses({ clients, lookup }) {
  return [...(clients ?? [])].sort().map((client) => {
    let resolved = null;
    try {
      resolved = lookup(client);
    } catch {
      resolved = null;
    }
    const path = typeof resolved === "string" && resolved.trim() !== "" ? resolved : null;
    return { client, command: client, found: path !== null, path };
  });
}

/**
 * A PATH probe, with everything ambient injected.
 *
 * Written here rather than shelled out to `command -v` so the installer makes the SAME decision these
 * tests make. A probe in bash beside a decision in JS is two implementations of one rule, and the one
 * nobody tests is the one that ships.
 *
 * @param {{pathValue: string, sep: string, pathExt: string[], isExecutable: (p: string) => boolean}} env
 * @returns {(command: string) => string|null}
 */
export function whichFrom({ pathValue, sep, pathExt, isExecutable }) {
  // The directory separator follows the PATH separator: ";" is Windows, everything else is POSIX.
  const joiner = sep === ";" ? "\\" : "/";
  // An empty segment (a doubled or trailing separator) would join to a RELATIVE path, making detection
  // depend on where the installer happened to be invoked from. Drop them.
  const dirs = String(pathValue ?? "").split(sep).map((d) => d.trim()).filter((d) => d !== "");
  const exts = pathExt?.length ? pathExt : [""];

  return (command) => {
    for (const dir of dirs) {
      const base = dir.endsWith(joiner) ? dir.slice(0, -1) : dir;
      for (const ext of exts) {
        const candidate = `${base}${joiner}${command}${ext}`;
        try {
          if (isExecutable(candidate)) return candidate;
        } catch {
          // One unreadable directory must not make every later directory unsearchable.
        }
      }
    }
    return null;
  };
}
