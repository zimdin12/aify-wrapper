// A REAL rendered launcher run all the way to a stub runtime that records what it was started with.
//
// The launcher is rendered by install.sh with its bridge directory written MSYS-style on Windows, as
// aify-comms' installer writes it. The bridge holds a stub `agent-for-handle.mjs`, which names the agent
// for one known handle and records what it was asked, and the definition reader
// (definition-reader-wrapper.mjs) unless a test leaves it out. The runtime is a stub that records its
// environment and argv; codex's `app-server` records its own argv and then listens, so the launcher gets
// past waiting for it. Nothing contacts a service: the endpoint is 127.0.0.2:1. HOME, the temp
// directories and the definitions directory are the run's own; nothing of this machine's environment
// reaches the launcher but what a shell needs.
//
// IMPORTED BY AIFY-ENV, by path (its instructions composition test): `launch(client, args, {definitions, env})`
// and the result's `run`, `args`, `sessionFiles` and `home` are an interface across repos. Tell aify-env first.

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerWrapper } from "./definition-reader-wrapper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
export const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32";
/** The handle the stub lookup answers for, and one it does not know. */
export const KNOWN = "11111111-2222-3333-4444-555555555555";
export const UNKNOWN = "99999999-8888-7777-6666-555555555555";

// Bash named outright, in the form this platform's node can spawn: the PATH handed to the launcher
// below is bash's, not node's. An absolute path on Linux too: a bare "bash" made BASH_DIR ".", so the
// launcher found bash and coreutils only where node happens to sit in /usr/bin (v0.7.2, external
// review: 9 failures under an nvm node).
const BASH = WIN
  ? execFileSync("bash", ["-lc", 'cygpath -w "$(command -v bash)"'], { encoding: "utf8" }).trim()
  : execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const BASH_DIR = path.dirname(BASH);
/** A path as the launcher's shell writes it: MSYS-style on Windows, which is what aify-comms bakes. */
const shellPath = (p) => (WIN ? execFileSync(BASH, ["-c", 'cygpath -u "$1"', "_", p], { encoding: "utf8" }).trim() : p);

// STUB LOOKUP. Answers `<runtime>-recovered` for the known handle only, and says what it was asked.
const LOOKUP = [
  'import fs from "node:fs";',
  "const [endpoint, runtime, handle] = process.argv.slice(2);",
  "fs.appendFileSync(process.env.STUB_LOOKUPS, JSON.stringify({ endpoint, runtime, handle }) + '\\n');",
  `if (handle === ${JSON.stringify(KNOWN)}) process.stdout.write(runtime + "-recovered\\n");`,
  "",
].join("\n");

/** A stub runtime: records its environment and argv, except codex's app-server, which records argv and listens. */
function runtimeStub(node) {
  return [
    "#!/bin/bash",
    'for a in "$@"; do if [ "$a" = "app-server" ]; then',
    '  printf "%s\\0" "$@" > "$STUB_RUNTIME_ENV.app-server"',
    '  env > "$STUB_RUNTIME_ENV.app-server-env"',
    '  url=""; prev=""; for b in "$@"; do [ "$prev" = "--listen" ] && url="$b"; prev="$b"; done',
    `  exec "${node}" -e 'require("net").createServer(s => s.end()).listen(Number(process.argv[1].split(":").pop()), "127.0.0.1")' "$url"`,
    "fi; done",
    'env > "$STUB_RUNTIME_ENV"',
    'printf "%s\\n" "$@" > "$STUB_RUNTIME_ENV.args"',
    'if [ "${STUB_LIFETIME_PROBE:-}" = "1" ]; then',
    '  parent="$PPID"; [ ! -r "/proc/$PPID/winpid" ] || read -r parent < "/proc/$PPID/winpid"',
    `  "${node}" -e 'const fs=require("fs"),p=require("path"); const d=p.join(process.env.HOME,".aify/residents"); const names=fs.existsSync(d)?fs.readdirSync(d):[]; fs.writeFileSync(process.env.STUB_RUNTIME_ENV+".residents", JSON.stringify({parent:Number(process.argv[1]),records:names.map(n=>({name:n,record:JSON.parse(fs.readFileSync(p.join(d,n)))}))})); if(process.env.AIFY_LIFETIME && names.length) { const old=JSON.parse(fs.readFileSync(p.join(d,names[0]))); const lifetime="8ecc46f8-9e99-4703-9df9-e34cc50faaba"; fs.writeFileSync(p.join(d,old.agentId+"."+lifetime+".json"),JSON.stringify({...old,lifetime})); }' "$parent"`,
    'fi',
    'exit "${STUB_EXIT:-0}"',
    "",
  ].join("\n");
}

// RENDERED ONCE PER INPUTS, PER TEST RUN. A render runs install.sh, the costliest step of a launch (24-33 s alone on the
// operator's host, three times that inside a full run), and most launches render the same inputs. So a render is kept
// under the run's temp directory, keyed by everything it is made from: the client, the reader, the registry and bridge
// files, and the bytes of the installer, the templates, bin/ and lib/. A later launch with the same key copies it into
// its own directory, every file its own, and points it at that directory: a render names its world only by the
// world's directory (bridge, wrapper, registry), and every world sits in the same parent, so the one directory name is
// replaced. `fresh: true` always renders; a-render-kept-for-a-run-is-the-render-it-would-make.test.js compares the two.
const RENDERS = () => path.join(os.tmpdir(), "aify-render-cache");
let sources = null;
/** The digest of what a render reads from this checkout, taken once per process. */
function sourceDigest() {
  if (sources) return sources;
  const hash = crypto.createHash("sha256");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(ROOT, full)}\0`).update(fs.readFileSync(full)).update("\0");
    }
  };
  hash.update(fs.readFileSync(INSTALL));
  for (const dir of ["wrappers", "bin", "lib"]) walk(path.join(ROOT, dir));
  sources = hash.digest("hex");
  return sources;
}
/** The key of a render: the same key, the same launcher text but for the world's directory. `sources` is this checkout's. */
export function renderKey(client, { reader, registry, bridgeFiles = {} }, sources = sourceDigest()) {
  const inputs = JSON.stringify({ client, reader: Boolean(reader), registry: registry === undefined ? null : registry, bridgeFiles, sources });
  return crypto.createHash("sha256").update(inputs).digest("hex");
}
/** Copy the render kept under `key` into `out`, renamed to world `dir`; whether there was one. */
function cachedRender(key, dir, out) {
  let kept;
  try {
    kept = JSON.parse(fs.readFileSync(path.join(RENDERS(), key, "render.json"), "utf8"));
  } catch {
    return false;
  }
  for (const { name, text, mode } of kept.files) {
    fs.writeFileSync(path.join(out, name), text.split(kept.world).join(path.basename(dir)), { mode });
  }
  return true;
}
/** Keep the render in `out`, made in world `dir`, under `key`, unless another launch kept it first. */
function keepRender(key, dir, out) {
  const files = fs.readdirSync(out).map((name) => ({ name, text: fs.readFileSync(path.join(out, name), "utf8"), mode: fs.statSync(path.join(out, name)).mode & 0o777 }));
  const temp = path.join(RENDERS(), `${key}.${process.pid}.${Date.now()}`);
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, "render.json"), JSON.stringify({ world: path.basename(dir), files }));
  try {
    fs.renameSync(temp, path.join(RENDERS(), key));
  } catch {
    fs.rmSync(temp, { recursive: true, force: true }); // another launch kept the same render first
  }
}

/** Render one launcher with a stub bridge and a stub runtime, in a fresh directory. */
function world(client, { reader, registry, bridgeFiles = {}, fresh = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-launch-${client}-`));
  const [out, stubs, home, bridge, wrapper] = ["out", "stubs", "home", "bridge", "wrapper"].map((d) => path.join(dir, d));
  for (const d of [out, stubs, home, bridge, wrapper]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bridge, "agent-for-handle.mjs"), LOOKUP);
  if (reader) readerWrapper(wrapper);
  for (const [name, text] of Object.entries(bridgeFiles)) fs.writeFileSync(path.join(bridge, name), text);
  // claude-aify keeps a `--resume` only for a session it can find on disk; codex-aify reads CODEX_HOME.
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  for (const id of [KNOWN, UNKNOWN]) fs.writeFileSync(path.join(home, ".claude", "projects", "p", `${id}.jsonl`), "{}\n");
  fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
  // The run's own registry, empty unless a test gives one. Without --registry the installer reads
  // ~/.aify/services.json of whoever runs the suite, and every launcher here was built against this
  // machine's services.
  const services = path.join(dir, "services.json");
  fs.writeFileSync(services, registry === undefined ? "" : JSON.stringify(registry));
  const key = renderKey(client, { reader, registry, bridgeFiles });
  const made = fresh || !cachedRender(key, dir, out) ? "rendered" : "kept";
  if (made === "rendered") {
    const rendered = spawnSync(BASH, [INSTALL, "--client", client, "--endpoint", NOWHERE, "--registry", services,
      "--render-only", out, "--bridge-dir", shellPath(bridge), "--wrapper-dir", shellPath(wrapper)], { encoding: "utf8", timeout: 120_000 });
    if (rendered.status !== 0) throw new Error(`render failed: ${rendered.stdout}\n${rendered.stderr}`);
    if (!fresh) keepRender(key, dir, out);
  }
  fs.writeFileSync(path.join(stubs, client), runtimeStub(shellPath(process.execPath)), { mode: 0o755 });
  return { dir, home, stubs, launcher: path.join(out, `${client}-aify`), made };
}

/**
 * Run `<client>-aify <args>` to its stub runtime.
 * @returns {{run, started: object, args: string[], appServerArgs: string[], asked: object[], sessionFiles: object}} `started`
 *   is the runtime's environment ({} when it never started); `args` its argv; `appServerArgs` codex's
 *   app-server argv; `sessionFiles` the text of each file left under ~/.aify/sessions, by its path below it.
 */
export function launch(client, args, { rewriting = true, reader = true, definitions = {}, env: extraEnv = {}, registry, edit, bridgeFiles, lifetimes = false, cwd, files = {}, fresh = false } = {}) {
  const w = world(client, { reader, registry, bridgeFiles, fresh });
  if (lifetimes) {
    for (const file of ["bin/aify-lease.sh", "bin/aify-inherited-session.sh", "bin/aify-lifetime.sh", "bin/aify-resident-record.mjs", "bin/aify-runtime-exited.sh"]) {
      const from = path.join(ROOT, file);
      if (!fs.existsSync(from)) continue; // RED runs before the new helpers exist.
      const to = path.join(w.dir, "wrapper", file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
  // A test that needs a launcher the installer would never write edits the rendered text, never the template.
  if (edit) fs.writeFileSync(w.launcher, edit(fs.readFileSync(w.launcher, "utf8")));
  const lookups = path.join(w.dir, "lookups");
  const runtimeEnv = path.join(w.dir, "runtime-env");
  const defs = definitionsEnv(path.join(w.dir, "defs"));
  for (const [id, body] of Object.entries(definitions)) {
    fs.writeFileSync(path.join(defs.AIFY_AGENT_DEFINITIONS_DIR, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  const env = {
    ...defs,
    ...extraEnv,
    PATH: [w.stubs, path.dirname(process.execPath), BASH_DIR].join(WIN ? ";" : ":"),
    HOME: w.home,
    USERPROFILE: w.home,
    APPDATA: path.join(w.home, "AppData/Roaming"),
    LOCALAPPDATA: path.join(w.home, "AppData/Local"),
    CODEX_HOME: path.join(w.home, ".codex"),
    TMPDIR: w.dir,
    TEMP: w.dir,
    TMP: w.dir,
    AIFY_HERMES_SKIP_NODE_CHECK: "1",
    AIFY_HERMES_DISABLE_PLUGIN: "1",
    STUB_LOOKUPS: lookups,
    STUB_RUNTIME_ENV: runtimeEnv,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(rewriting ? {} : { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }),
  };
  // `files` are written under the run's own directory before it starts, `<home>` naming its HOME; `cwd` is
  // where the launcher runs, relative to that directory. A file's text may be a function of the run's
  // {dir, home, bridge}, for contents that name its absolute paths.
  for (const [rel, text] of Object.entries(files)) {
    const to = path.join(w.dir, rel.replace(/^<home>/, path.relative(w.dir, w.home)));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, typeof text === "function" ? text({ dir: w.dir, home: w.home, bridge: path.join(w.dir, "bridge") }) : text);
  }
  const workdir = cwd === undefined ? undefined : path.join(w.dir, cwd);
  if (workdir) fs.mkdirSync(workdir, { recursive: true });
  const run = spawnSync(BASH, [w.launcher, ...args], { encoding: "utf8", env, timeout: 60_000, cwd: workdir });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const lines = (file) => read(file).split(/\r?\n/).filter(Boolean);
  const started = Object.fromEntries(lines(runtimeEnv).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const asked = lines(lookups).map((l) => JSON.parse(l));
  const residents = path.join(w.home, ".aify/residents");
  // What the launch left in ~/.aify/sessions, by path below it, read before the run's directory is removed.
  const sessions = path.join(w.home, ".aify", "sessions");
  const sessionFiles = fs.existsSync(sessions) ? Object.fromEntries(fs.readdirSync(sessions, { recursive: true })
    .filter((rel) => fs.statSync(path.join(sessions, rel)).isFile()).map((rel) => [rel.split(path.sep).join("/"), read(path.join(sessions, rel))])) : {};
  const result = { sessionFiles, home: w.home, run, started, asked, args: lines(`${runtimeEnv}.args`), appServerArgs: read(`${runtimeEnv}.app-server`).split("\0").filter(Boolean),
    appServerEnv: Object.fromEntries(lines(`${runtimeEnv}.app-server-env`).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
    lifetimeProbe: read(`${runtimeEnv}.residents`) ? JSON.parse(read(`${runtimeEnv}.residents`)) : null,
    remainingResidents: fs.existsSync(residents) ? fs.readdirSync(residents) : [], launcher: w.launcher, render: w.made,
    exitReport: read(`${runtimeEnv}.exit`) ? JSON.parse(read(`${runtimeEnv}.exit`)) : null };
  fs.rmSync(w.dir, { recursive: true, force: true });
  return result;
}
