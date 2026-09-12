// Finding the `herdr` binary, without assuming it is on PATH.
//
// WHY THIS EXISTS. The first real `herdr-aify` run failed with `spawn herdr ENOENT` on a machine
// where Herdr was installed and working. Measured afterwards: the Herdr install directory is on
// NEITHER the user nor the system PATH in the registry — Herdr puts it on PATH for the shells IT
// starts (a pane's `HERDR_BIN_PATH`), and for a shell that inherited it from whatever launched it.
// From an ordinary prompt, `herdr` does not resolve, so a launcher that spawns the bare name works
// for the developer and fails for the operator.
//
// SO THE NAME IS THE LAST RESORT, NOT THE FIRST. Herdr's own installer maintains a stable
// `packages/standalone/current` symlink beside the versioned release directories, which is the
// supported way to name the current binary without pinning a version.
//
// AND A FAILURE HAS TO SAY WHERE IT LOOKED. `ENOENT` on a bare name tells an operator nothing they
// can act on; the list of places tried is the whole diagnosis.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Windows ships `herdr.exe`; everywhere else it is extensionless. */
function binaryNames(platform) {
  return platform === "win32" ? ["herdr.exe", "herdr"] : ["herdr"];
}

/**
 * Every place a herdr binary might be, in the order they should be trusted.
 *
 * `HERDR_BIN_PATH` FIRST because inside a pane it names the exact binary that opened that pane —
 * which removes the whole class of "talked to a different Herdr".
 */
export function candidatePaths({ env = process.env, home = os.homedir(), platform = process.platform, io = fs } = {}) {
  const found = [];
  const add = candidate => {
    if (candidate && !found.includes(candidate)) found.push(candidate);
  };

  add(env.HERDR_BIN_PATH);

  const standalone = path.join(home, ".herdr", "packages", "standalone");
  for (const name of binaryNames(platform)) add(path.join(standalone, "current", name));

  // A release directory directly, for an install whose `current` link is missing or broken.
  let releases = [];
  try {
    releases = io.readdirSync(path.join(standalone, "releases")).sort().reverse();
  } catch {
    // No releases directory is simply one fewer place to look.
  }
  for (const release of releases) {
    for (const name of binaryNames(platform)) add(path.join(standalone, "releases", release, name));
  }
  return found;
}

/**
 * The herdr binary to run, or a refusal naming every place that was tried.
 *
 * FALLS BACK TO THE BARE NAME only when nothing was found on disk: on a host where Herdr is
 * installed somewhere this does not know about but IS on PATH, the bare name still works, and
 * spending a spawn to find that out is cheaper than refusing a working configuration.
 */
export function resolveHerdrBinary(options = {}) {
  const io = options.io || fs;
  const env = options.env || process.env;

  // AN EXPLICIT `HERDR_BIN_PATH` IS AUTHORITATIVE and is not second-guessed. Inside a pane it is
  // Herdr's own statement of which binary opened that pane, so searching past it — because a stat
  // failed, on a path that may be perfectly valid to the OS — would mean silently talking to a
  // DIFFERENT Herdr than the one that asked. If it is wrong, the spawn error names it, which is a
  // better failure than quietly succeeding against the wrong server.
  if (typeof env.HERDR_BIN_PATH === "string" && env.HERDR_BIN_PATH !== "") {
    return { ok: true, bin: env.HERDR_BIN_PATH, tried: [env.HERDR_BIN_PATH], why: null };
  }

  const candidates = candidatePaths(options);
  for (const candidate of candidates) {
    try {
      if (io.existsSync(candidate)) return { ok: true, bin: candidate, tried: candidates, why: null };
    } catch {
      // An unreadable candidate is not a match.
    }
  }
  return {
    ok: false,
    // The bare name is still worth trying, and the caller is told the search failed.
    bin: "herdr",
    tried: candidates,
    why:
      "no herdr binary was found on disk, and the Herdr install directory is not on PATH on this " +
      "host by default. Tried: " + (candidates.length ? candidates.join(", ") : "(nothing)") +
      ". Install Herdr, or set HERDR_BIN_PATH to the binary.",
  };
}
