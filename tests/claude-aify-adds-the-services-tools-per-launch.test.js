#!/usr/bin/env node
// Installed with `--mcp-transport http`, claude-aify gives each launch the service's comms tools over HTTP, called
// as the launch's agent, in a per-session `--mcp-config` file it removes on exit, and exports AIFY_COMMS_MCP=http
// so the channel holds the resident duties (aify-comms 0.9.11 slice 4).
//
// The real installer renders the real launcher; a stub `claude` records its arguments, its environment and every
// config file it was handed. The entry is the generic one (lib/session-http.mjs, bin/aify-session-mcp.mjs), with the
// launcher's own service in it; it was aify-comms' own comms-http-entry.mjs until the generic entry carried comms too.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerWrapper } from "./definition-reader-wrapper.mjs";
import { ownerEnv, writePrivateCredential } from "./private-credential.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const KEY = "comms-key-for-this-test-only-0123456789";
const WIN = process.platform === "win32";
const SEP = WIN ? ";" : ":";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const winPath = (p) => (WIN ? execFileSync("bash", ["-c", `cygpath -w "${posix(p)}"`], { encoding: "utf8" }).trim() : p);
const bashDir = () => winPath(execFileSync("bash", ["-c", 'dirname "$(command -v bash)"'], { encoding: "utf8" }).trim());
const REGISTRY = { version: 1, services: { "aify-comms": { endpoint: NOWHERE, endpointEnv: ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"], credentialRef: "aify-comms.key", mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }] } } };

function launch({ transport, env = {}, withEntry = true }) {
  const world = install({ transport, withEntry });
  const result = start(world, { env });
  fs.rmSync(world.dir, { recursive: true, force: true });
  return result;
}

/** The real installer's launcher, with a stub `claude` and `aify-env` that record what they were handed. */
function install({ transport, withEntry = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-http-launch-"));
  const [out, stubs, home, bridge, seen] = ["out", "stubs", "home", "bridge", "seen"].map((d) => path.join(dir, d));
  for (const d of [out, stubs, home, bridge, seen]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bridge, "claude-channel.js"), "");
  writePrivateCredential(home, "aify-comms.key", KEY);
  const registryFile = path.join(dir, "services.json");
  fs.writeFileSync(registryFile, JSON.stringify(REGISTRY));
  const wrapper = readerWrapper(path.join(dir, "wrapper"));
  if (!withEntry) fs.rmSync(path.join(wrapper, "bin", "aify-session-mcp.mjs"));
  const rendered = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", out, "--registry", registryFile,
    "--bridge-dir", posix(bridge), "--wrapper-dir", posix(wrapper), "--mcp-transport", transport], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);
  const s = posix(seen);
  fs.writeFileSync(path.join(stubs, "claude"), [
    "#!/bin/sh",
    `printf '%s\\n' "\${AIFY_COMMS_MCP-<unset>}" > "${s}/env"`,
    "n=0",
    "while [ $# -gt 0 ]; do",
    `  printf '%s\\n' "$1" >> "${s}/argv"`,
    '  case "$1" in --mcp-config=*) _f="${1#--mcp-config=}" ;; --mcp-config) _f="$2" ;; *) _f="" ;; esac',
    `  if [ -n "$_f" ]; then n=$((n+1)); cp "$_f" "${s}/config-$n.json"; printf '%s\\n' "$_f" >> "${s}/paths"; fi`,
    "  shift",
    "done",
    "exit 0",
    "",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(path.join(stubs, "claude"), 0o755);
  fs.writeFileSync(path.join(stubs, "aify-env"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${s}/aify-env"\nexit 0\n`);
  fs.chmodSync(path.join(stubs, "aify-env"), 0o755);
  return { dir, home, out, wrapper, seen, stubs, document: path.join(home, ".aify", "sessions", "probe-agent", "mcp.json") };
}

/**
 * A lease whose claim refuses as the real one does for an agent already running (75), so no runtime starts. In the
 * wrapper's bin/, where the launcher sources it; without it the launcher's own stubs admit every start.
 */
const REFUSING_LEASE = [
  'aify_lease_take_intent() { AIFY_LEASE_ARGS=("$@"); }',
  'aify_lease_claim() { echo "[lease] $1 is already running here" >&2; return 75; }',
  "aify_lease_attach() { :; }", "aify_lease_release() { :; }", "aify_lifetime_start() { :; }", "aify_lifetime_release() { :; }",
  "aify_lease_pid() { printf '%s' \"$1\"; }", "",
].join("\n");

/** Run the installed launcher once; what each stub recorded is this run's alone. */
function start(world, { env = {}, args = [], lease = null, cwd } = {}) {
  const { dir, home, out, wrapper, seen, stubs } = world;
  for (const f of fs.readdirSync(seen)) fs.rmSync(path.join(seen, f));
  const leaseFile = path.join(wrapper, "bin", "aify-lease.sh");
  if (lease) fs.writeFileSync(leaseFile, lease);
  else fs.rmSync(leaseFile, { force: true });
  const run = spawnSync("bash", [path.join(out, "claude-aify"), ...args], {
    encoding: "utf8",
    cwd,
    env: { PATH: [winPath(stubs), path.dirname(process.execPath), bashDir()].join(SEP), HOME: posix(home), USERPROFILE: home, ...ownerEnv(),
      AIFY_MACHINE_ID: "host-a", ...definitionsEnv(path.join(dir, "defs")), HARNESS_IDENTITY: "probe-agent", ...env },
    timeout: 60_000,
  });
  const read = (name) => (fs.existsSync(path.join(seen, name)) ? fs.readFileSync(path.join(seen, name), "utf8") : "");
  const configs = fs.readdirSync(seen).filter((f) => f.startsWith("config-")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(seen, f), "utf8")));
  return { run, args: read("argv").split("\n").filter(Boolean), commsMcp: read("env").trim(), configs,
    paths: read("paths").split("\n").filter(Boolean), handedToHost: read("aify-env").split("\n").filter(Boolean) };
}

/** The entry the own service gets: at the endpoint the launch resolved, as its agent, with its credential's key. */
const httpEntry = (url = NOWHERE) => ({ type: "http", url: `${url}/mcp/http`, headers: { "X-Aify-Agent-Id": "probe-agent", "X-API-Key": KEY } });
/** The launch-specific headers, which session-http.test.js holds; here only the service's own fields are compared. */
const own = (config) => {
  const { "X-Aify-Machine-Id": machine, "X-Aify-Launch-Folder": folder, ...headers } = config.mcpServers["aify-comms"].headers;
  assert.match(machine, /:host-a$/);
  assert.ok(folder);
  return { ...config.mcpServers["aify-comms"], headers };
};

test("an http install gives the launch the service's tools as its agent, says so to the channel, from its session file", () => {
  const { run, args, commsMcp, configs, paths } = launch({ transport: "http" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(configs.map((c) => Object.keys(c.mcpServers)), [["aify-comms"]]);
  assert.deepEqual(own(configs[0]), httpEntry());
  assert.equal(commsMcp, "http");
  assert.ok(!args.includes("--strict-mcp-config"), "the default mode was made strict");
  // The agent's one owner-only file (tests/session-folder.test.js), never a per-launch file in the session's temp.
  assert.match(posix(paths[0]), /\/\.aify\/sessions\/probe-agent\/mcp\.json$/);
});

test("the own service is reached at the endpoint this launch resolved, and its credential goes only to the endpoint it opens", () => {
  // Bug this catches: an exported endpoint ignored (the channel and the tools on two services), or the registry's
  // credential sent to wherever the endpoint was pointed.
  const moved = "http://127.0.0.2:2";
  const { run, configs } = launch({ transport: "http", env: { AIFY_COMMS_URL: moved } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(own(configs[0]), { ...httpEntry(moved), headers: { "X-Aify-Agent-Id": "probe-agent" } });
  assert.match(run.stderr, /aify-comms: no key found \(its credential opens http:\/\/127\.0\.0\.2:1, and this launch sends to http:\/\/127\.0\.0\.2:2\)/);
});

test("in strict mode the service's tools come from the same per-launch file, beside the channel", () => {
  const { run, configs } = launch({ transport: "http", env: { AIFY_CLAUDE_STRICT_MCP: "1" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(configs.map((c) => Object.keys(c.mcpServers)), [["aify-comms-channel"], ["aify-comms"]]);
  assert.deepEqual(own(configs[1]), httpEntry());
});

// Started from a shell an http launch exported the switch into (a Herdr pane, an agent's own terminal), a stdio
// launch still says stdio: the channel and the hermes plugin act on the switch alone.
test("control: a stdio install launches as before, with no per-launch entry and no switch, even one inherited", () => {
  const { run, configs, commsMcp } = launch({ transport: "stdio", env: { AIFY_COMMS_MCP: "http" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([configs, commsMcp], [[], "<unset>"]);
});

test("an entry that cannot be written stops the launch rather than starting it without the tools", () => {
  const { run, args } = launch({ transport: "http", withEntry: false });
  assert.equal(run.status, 78, run.stderr);
  assert.match(run.stderr, /this session's MCP entries could not be written/);
  assert.deepEqual(args, [], "claude was started anyway");
});

// THE FILE IS THE AGENT'S ONE, so only a start the lease admits may write it: written above the claim, a second launch
// of a running agent, refused with 75, rewrote the running session's document with its own endpoint and folder
// (review of f177604).
test("a second launch the lease refuses leaves the running agent's document as it was", () => {
  const world = install({ transport: "http" });
  try {
    const first = start(world, { cwd: world.home });
    assert.equal(first.run.status, 0, first.run.stderr);
    const before = fs.readFileSync(world.document);
    const elsewhere = path.join(world.dir, "refused-work");
    fs.mkdirSync(elsewhere);
    const refused = start(world, { lease: REFUSING_LEASE, cwd: elsewhere, env: { AIFY_COMMS_URL: "http://127.0.0.2:2" } });
    assert.equal(refused.run.status, 75, refused.run.stderr);
    assert.deepEqual(refused.args, [], "claude was started anyway");
    assert.ok(fs.readFileSync(world.document).equals(before), `the running agent's document was rewritten:\n${fs.readFileSync(world.document, "utf8")}`);
    // CONTROL: the same changed launch, admitted, does rewrite it, so an unchanged file above is not one nothing could change.
    const admitted = start(world, { cwd: elsewhere, env: { AIFY_COMMS_URL: "http://127.0.0.2:2" } });
    assert.equal(admitted.run.status, 0, admitted.run.stderr);
    assert.notDeepEqual(fs.readFileSync(world.document), before);
  } finally {
    fs.rmSync(world.dir, { recursive: true, force: true });
  }
});

test("a --shared launch writes no document: the run the host starts in its place claims and writes its own", () => {
  const world = install({ transport: "http" });
  try {
    const shared = start(world, { args: ["--shared"] });
    assert.equal(shared.run.status, 0, shared.run.stderr);
    assert.ok(shared.handedToHost.includes("run"), `control: the launch was handed to aify-env: ${shared.run.stderr}`);
    assert.equal(fs.existsSync(world.document), false, "a --shared launch wrote the agent's document");
  } finally {
    fs.rmSync(world.dir, { recursive: true, force: true });
  }
});

// Hermes has no per-launch MCP flag: its comms entry is the installed one (aify-comms' install.sh). What its launcher
// owns is the switch that makes the delivery loop register the agent. Rendered by the real installer, and the
// rendered lines run in their order, for both transports, from a shell that already holds an inherited switch.
test("hermes-aify exports the switch only from an http install", () => {
  const exported = (transport) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-render-"));
    const registryFile = path.join(dir, "services.json");
    fs.writeFileSync(registryFile, JSON.stringify(REGISTRY));
    const rendered = spawnSync("bash", [INSTALL, "--client", "hermes", "--endpoint", NOWHERE, "--render-only", path.join(dir, "out"),
      "--registry", registryFile, "--bridge-dir", posix(path.join(dir, "bridge")), "--mcp-transport", transport], { encoding: "utf8", timeout: 120_000 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const text = fs.readFileSync(path.join(dir, "out", "hermes-aify"), "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
    const lines = text.split("\n").filter((l) => l.includes("export AIFY_COMMS_MCP=http"));
    assert.equal(lines.length, 1, "the switch line is missing or repeated");
    // At top level and before the switch, so no launch, whatever its arguments, keeps a shell's switch.
    const clear = text.split("\n").filter((l) => /^unset AIFY_COMMS_MCP\b/.test(l));
    assert.equal(clear.length, 1, "the inherited switch is not cleared at top level");
    assert.ok(text.indexOf(clear[0]) < text.indexOf(lines[0]), "the switch is cleared after it is set");
    const run = spawnSync("bash", ["-c", [clear[0], lines[0], 'printf %s "${AIFY_COMMS_MCP-unset}"'].join("\n")],
      { encoding: "utf8", env: { ...process.env, AIFY_COMMS_MCP: "http" } });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  assert.deepEqual([exported("http"), exported("stdio")], ["http", "unset"]);
});
