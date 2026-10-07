// A REAL rendered launcher run all the way to a stub runtime that records what it was started with.
//
// The launcher is rendered by install.sh with its bridge directory written MSYS-style on Windows, as
// aify-comms' installer writes it. The bridge holds a stub `agent-for-handle.mjs`, which names the agent
// for one known handle and records what it was asked, and the definition reader
// (definition-reader-bridge.mjs) unless a test leaves it out. The runtime is a stub that records its
// environment and argv; codex's `app-server` records its own argv and then listens, so the launcher gets
// past waiting for it. Nothing contacts a service: the endpoint is 127.0.0.2:1. HOME, the temp
// directories and the definitions directory are the run's own; nothing of this machine's environment
// reaches the launcher but what a shell needs.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerBridge } from "./definition-reader-bridge.mjs";

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

/** Render one launcher with a stub bridge and a stub runtime, in a fresh directory. */
function world(client, { reader, registry, bridgeFiles = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-launch-${client}-`));
  const [out, stubs, home, bridge] = ["out", "stubs", "home", "bridge"].map((d) => path.join(dir, d));
  for (const d of [out, stubs, home, bridge]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bridge, "agent-for-handle.mjs"), LOOKUP);
  if (reader) readerBridge(bridge);
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
  const rendered = spawnSync(BASH, [INSTALL, "--client", client, "--endpoint", NOWHERE, "--registry", services,
    "--render-only", out, "--bridge-dir", shellPath(bridge)], { encoding: "utf8", timeout: 120_000 });
  if (rendered.status !== 0) throw new Error(`render failed: ${rendered.stdout}\n${rendered.stderr}`);
  fs.writeFileSync(path.join(stubs, client), runtimeStub(shellPath(process.execPath)), { mode: 0o755 });
  return { dir, home, stubs, launcher: path.join(out, `${client}-aify`) };
}

/**
 * Run `<client>-aify <args>` to its stub runtime.
 * @returns {{run, started: object, args: string[], appServerArgs: string[], asked: object[]}} `started` is
 *   the runtime's environment ({} when it never started); `args` its argv; `appServerArgs` codex's
 *   app-server argv.
 */
export function launch(client, args, { rewriting = true, reader = true, definitions = {}, env: extraEnv = {}, registry, edit, bridgeFiles, lifetimes = false } = {}) {
  const w = world(client, { reader, registry, bridgeFiles });
  if (lifetimes) {
    for (const file of ["bin/aify-lease.sh", "bin/aify-inherited-session.sh", "bin/aify-lifetime.sh", "bin/aify-resident-record.mjs", "bin/aify-runtime-exited.sh"]) {
      const from = path.join(ROOT, file);
      if (!fs.existsSync(from)) continue; // RED runs before the new helpers exist.
      const to = path.join(w.dir, "bridge/node_modules/aify-wrapper", file);
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
  const run = spawnSync(BASH, [w.launcher, ...args], { encoding: "utf8", env, timeout: 60_000 });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const lines = (file) => read(file).split(/\r?\n/).filter(Boolean);
  const started = Object.fromEntries(lines(runtimeEnv).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const asked = lines(lookups).map((l) => JSON.parse(l));
  const residents = path.join(w.home, ".aify/residents");
  const result = { run, started, asked, args: lines(`${runtimeEnv}.args`), appServerArgs: read(`${runtimeEnv}.app-server`).split("\0").filter(Boolean),
    appServerEnv: Object.fromEntries(lines(`${runtimeEnv}.app-server-env`).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
    lifetimeProbe: read(`${runtimeEnv}.residents`) ? JSON.parse(read(`${runtimeEnv}.residents`)) : null,
    remainingResidents: fs.existsSync(residents) ? fs.readdirSync(residents) : [], launcher: w.launcher,
    exitReport: read(`${runtimeEnv}.exit`) ? JSON.parse(read(`${runtimeEnv}.exit`)) : null };
  fs.rmSync(w.dir, { recursive: true, force: true });
  return result;
}
