// A PATH holding exactly the runtimes a test asks for, and none of the machine's own.
//
// THE LEAK THIS ENDS. Rendering with `install.sh --all` and running a launcher's `--check` both look up
// coding-agent CLIs on PATH, so a test that inherits the real PATH measures the machine it runs on. On
// the Windows host that wrote this suite every runtime is installed and all of it passed; a Linux clone
// with only `codex` failed 31 tests -- `--all` rendered one launcher where the tests read three, and
// `claude-aify --check` exited 127. Nothing in those tests had changed; the host had.
//
// THE BASH DIRECTORY IS NOT SAFE TO BORROW. install.sh needs bash and coreutils, and install-all's
// first seal put bash's own directory on PATH to get them. On Windows that is Git's usr/bin, which
// holds no runtime. On Linux it is /usr/bin, which is exactly where a package manager puts `codex` --
// and the SEAL CONTROL test that exists to prove nothing leaks went red on the first Linux run for that
// reason. So on POSIX the directory is MIRRORED, one symlink per entry, minus every runtime command.
// On Windows it is used directly, but only after checking it holds none: a guard that assumed so would
// pass on the day it stopped being true.
//
// THE RUNTIME NAMES ARE DERIVED, not typed. Clients come from the wrapper templates, the way install.sh
// derives them, and each template's own "runtime CLI '...' was not found" line names the command it
// resolves -- which is how pi's `omp` is found without anybody remembering that pi's CLI has another
// name. A list typed here would leak the first runtime added after it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { harnessClientsFrom } from "../lib/detect-harnesses.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPERS = path.join(ROOT, "wrappers");
const WIN = process.platform === "win32";
const PATH_SEP = WIN ? ";" : ":";

/** Every client a wrapper template declares; the same derivation install.sh's `--all` uses. */
export const HARNESS_CLIENTS = harnessClientsFrom(fs.readdirSync(WRAPPERS));

/**
 * The clients `--all` is expected to render in this suite: every one except pi.
 *
 * pi is left unstubbed because `shared-hands-the-session-to-the-host` pins `pi-aify` as the template
 * that renders nothing. install.sh itself would render it given a `pi` on PATH -- detection probes the
 * CLIENT name, and pi's CLI is `omp` -- so this is the suite's premise, written down once, not a
 * property of the installer.
 */
export const CLIENTS_ALL_RENDERS = HARNESS_CLIENTS.filter((client) => client !== "pi");

/** A template's runtime command, from its not-found line, with a `$VAR` resolved to its default. */
function runtimeCommandOf(template) {
  const named = /runtime CLI '([^']+)' was not found/.exec(template);
  if (!named) return null;
  if (!named[1].startsWith("$")) return named[1];
  const variable = named[1].slice(1);
  const assigned = new RegExp(`^${variable}="\\$\\{.*:-([A-Za-z0-9_-]+)\\}+"`, "m").exec(template);
  // FAILS CLOSED. An unresolved name would silently leave that runtime in the mirror.
  if (!assigned) throw new Error(`sealed-path: cannot resolve the runtime command ${named[1]}`);
  return assigned[1];
}

/** Every command name a launcher or the detector resolves as a runtime. Kept out of every seal. */
export const RUNTIME_COMMANDS = [...new Set([
  ...HARNESS_CLIENTS,
  ...HARNESS_CLIENTS
    .map((client) => runtimeCommandOf(fs.readFileSync(path.join(WRAPPERS, `${client}-aify.sh.in`), "utf8")))
    .filter(Boolean),
])].sort();

/** Where bash lives, as bash reports it. install.sh shells out to render.sh, so bash must be reachable. */
function bashDir() {
  return execFileSync("bash", ["-c", "dirname \"$(command -v bash)\""], { encoding: "utf8" }).trim();
}

/** A POSIX path in the form this platform's PATH wants. */
function forPath(dir) {
  if (!WIN) return dir;
  return execFileSync("bash", ["-c", `cygpath -w "${dir.replace(/\\/g, "/")}"`], { encoding: "utf8" }).trim();
}

let TOOLS = null;

/** The directory supplying bash and its tools, with no runtime in it. Built once per process. */
function toolsDir() {
  if (TOOLS) return TOOLS;
  const source = forPath(bashDir());
  if (WIN) {
    const exts = ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
    const present = new Set(fs.readdirSync(source).map((name) => name.toLowerCase()));
    const leaked = RUNTIME_COMMANDS.filter((command) => exts.some((ext) => present.has(`${command}${ext}`.toLowerCase())));
    if (leaked.length > 0) {
      throw new Error(`sealed-path: ${source} holds runtime(s) ${leaked.join(", ")}, so it cannot seal a PATH`);
    }
    TOOLS = source;
    return TOOLS;
  }
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sealed-tools-"));
  const excluded = new Set(RUNTIME_COMMANDS);
  for (const name of fs.readdirSync(source)) {
    if (excluded.has(name)) continue;
    fs.symlinkSync(path.join(source, name), path.join(mirror, name));
  }
  TOOLS = mirror;
  return TOOLS;
}

/**
 * A sealed PATH: a stub for each runtime asked for, a `node` shim, and bash with its tools.
 *
 * `node` is a shim rather than node's own directory because that directory holds real runtimes on
 * hosts where they are installed through npm -- `codex` among them.
 *
 * @param {string[]} runtimes command names to stub; each exits 0 and does nothing else
 * @returns {{dir: string, stubs: string, PATH: string}}
 */
export function sealedPath(runtimes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sealed-"));
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs, { recursive: true });

  fs.writeFileSync(path.join(stubs, "node"), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "$@"\n`);
  fs.chmodSync(path.join(stubs, "node"), 0o755);
  for (const runtime of runtimes) {
    fs.writeFileSync(path.join(stubs, runtime), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(stubs, runtime), 0o755);
  }

  return { dir, stubs, PATH: [forPath(stubs), toolsDir()].join(PATH_SEP) };
}

/**
 * `env` with PATH replaced, whatever case it was spelled in.
 *
 * Windows spells it `Path`, and spreading process.env then adding `PATH` leaves both keys for the
 * child to choose between -- which is a seal that holds or not depending on which one it picks.
 */
export function withPath(env, PATH) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== "PATH") out[key] = value;
  out.PATH = PATH;
  return out;
}
