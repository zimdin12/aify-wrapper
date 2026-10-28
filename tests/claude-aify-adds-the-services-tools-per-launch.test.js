#!/usr/bin/env node
// Installed with `--mcp-transport http`, claude-aify gives each launch the service's comms tools over HTTP, called
// as the launch's agent, in a per-session `--mcp-config` file it removes on exit, and exports AIFY_COMMS_MCP=http
// so the channel holds the resident duties (aify-comms 0.9.11 slice 4).
//
// The real installer renders the real launcher; a stub `claude` records its arguments, its environment and every
// config file it was handed. The entry itself comes from aify-comms' own `comms-http-entry.mjs` (its URL and
// header are that service's contract), run through a one-line shim in the bridge directory so the launcher's
// arguments reach the real script.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerWrapper } from "./definition-reader-wrapper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const COMMS_STDIO = path.join(process.env.AIFY_COMMS_REPO || path.resolve(ROOT, "../aify-comms"), "mcp", "stdio");
const ENTRY = path.join(COMMS_STDIO, "comms-http-entry.mjs");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32";
const SEP = WIN ? ";" : ":";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const winPath = (p) => (WIN ? execFileSync("bash", ["-c", `cygpath -w "${posix(p)}"`], { encoding: "utf8" }).trim() : p);
const bashDir = () => winPath(execFileSync("bash", ["-c", 'dirname "$(command -v bash)"'], { encoding: "utf8" }).trim());
const REGISTRY = { version: 1, services: { "aify-comms": { endpoint: NOWHERE, endpointEnv: ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"], mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }] } } };

function launch({ transport, env = {}, withEntry = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-http-launch-"));
  const [out, stubs, home, bridge, seen] = ["out", "stubs", "home", "bridge", "seen"].map((d) => path.join(dir, d));
  for (const d of [out, stubs, home, bridge, seen]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bridge, "claude-channel.js"), "");
  if (withEntry) {
    fs.writeFileSync(path.join(bridge, "comms-http-entry.mjs"), `import { spawnSync } from "node:child_process";
process.exit(spawnSync(process.execPath, [${JSON.stringify(ENTRY)}, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);
`);
  }
  const registryFile = path.join(dir, "services.json");
  fs.writeFileSync(registryFile, JSON.stringify(REGISTRY));
  const rendered = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", out, "--registry", registryFile,
    "--bridge-dir", posix(bridge), "--wrapper-dir", posix(readerWrapper(path.join(dir, "wrapper"))), "--mcp-transport", transport], { encoding: "utf8", timeout: 120_000 });
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
  const run = spawnSync("bash", [path.join(out, "claude-aify")], {
    encoding: "utf8",
    env: { PATH: [winPath(stubs), path.dirname(process.execPath), bashDir()].join(SEP), HOME: posix(home), USERPROFILE: home,
      ...definitionsEnv(path.join(dir, "defs")), HARNESS_IDENTITY: "probe-agent", ...env },
    timeout: 60_000,
  });
  const read = (name) => (fs.existsSync(path.join(seen, name)) ? fs.readFileSync(path.join(seen, name), "utf8") : "");
  const configs = fs.readdirSync(seen).filter((f) => f.startsWith("config-")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(seen, f), "utf8")));
  const result = { run, args: read("argv").split("\n").filter(Boolean), commsMcp: read("env").trim(), configs,
    paths: read("paths").split("\n").filter(Boolean) };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const httpEntry = { type: "http", url: `${NOWHERE}/mcp/http`, headers: { "X-Aify-Agent-Id": "probe-agent" } };

test("an http install gives the launch the service's tools as its agent, says so to the channel, and removes the file", (t) => {
  if (!fs.existsSync(ENTRY)) { assert.ok(!process.env.AIFY_COMMS_REPO, "AIFY_COMMS_REPO has no comms-http-entry.mjs"); return t.skip("needs aify-comms' comms-http-entry.mjs; set AIFY_COMMS_REPO"); }
  const { run, args, commsMcp, configs, paths } = launch({ transport: "http" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(configs, [{ mcpServers: { "aify-comms": httpEntry } }]);
  assert.equal(commsMcp, "http");
  assert.ok(!args.includes("--strict-mcp-config"), "the default mode was made strict");
  assert.equal(fs.existsSync(WIN ? winPath(paths[0]) : paths[0]), false, "the per-launch file outlived the launch");
});

test("in strict mode the service's tools come from the same per-launch file, beside the channel", (t) => {
  if (!fs.existsSync(ENTRY)) return t.skip("needs aify-comms' comms-http-entry.mjs");
  const { run, configs } = launch({ transport: "http", env: { AIFY_CLAUDE_STRICT_MCP: "1" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(configs.map((c) => Object.keys(c.mcpServers)), [["aify-comms-channel"], ["aify-comms"]]);
  assert.deepEqual(configs[1].mcpServers["aify-comms"], httpEntry);
});

// Started from a shell an http launch exported the switch into (a Herdr pane, an agent's own terminal), a stdio
// launch still says stdio: the channel and the hermes plugin act on the switch alone.
test("control: a stdio install launches as before, with no per-launch entry and no switch, even one inherited", () => {
  const { run, configs, commsMcp } = launch({ transport: "stdio", env: { AIFY_COMMS_MCP: "http" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([configs, commsMcp], [[], "<unset>"]);
});

test("a bridge that cannot write the entry stops the launch rather than starting it without the tools", () => {
  const { run, args } = launch({ transport: "http", withEntry: false });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /comms tools entry could not be written/);
  assert.deepEqual(args, [], "claude was started anyway");
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
