#!/usr/bin/env node
// Per-session MCP over HTTP (lib/session-http.mjs, bin/aify-session-mcp.mjs): a service is reached at its
// `<endpoint>/mcp/http`, as the launch's agent, instead of through a local process per session.
//
// WHAT MUST HOLD. Claude gets one file per launch with the four agreed headers, removed when the launch ends; a
// service with no key still gets its entry, without X-API-Key, and is named; strict mode carries only the launcher's
// own service; Hermes gets one machine-wide entry whose per-launch values are Hermes' own variables; Codex keeps the
// local process; and a service that does not declare http launches exactly as before. The own service's launch path
// and the AIFY_COMMS_MCP switch are tests/claude-aify-adds-the-services-tools-per-launch.test.js; which key wins is
// tests/the-session-key-is-resolved-as-comms-resolves-it.test.js.
//
// Every case owns its registry, home and credential file, so no real registry, key or Hermes is read or written.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerWrapper } from "./definition-reader-wrapper.mjs";
import { renderWorld } from "./launch-to-a-stub-runtime.mjs";
import { ownerEnv, writePrivateCredential } from "./private-credential.mjs";

import { folderCustodyProblemFor } from "../lib/credential-custody.mjs";
import { parseRegistry, reachedOverHttp, sessionMcpEntriesFor } from "../lib/registry.mjs";
import { sessionCodexWords } from "../lib/session-codex.mjs";
import { sessionHermesEntries } from "../lib/session-hermes.mjs";
import {
  claudeHttpServers, hermesHttpEntries, sessionEndpoint, sessionHttpBase64, sessionHttpFromBase64, sessionHttpServices,
} from "../lib/session-http.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_CLI = path.join(ROOT, "lib", "registry-cli.mjs");
const HERMES_CLI = path.join(ROOT, "lib", "hermes-config-cli.mjs");
const FAKE_HERMES = path.join(ROOT, "tests", "fake-hermes.mjs");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32";
const SEP = WIN ? ";" : ":";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const winPath = (p) => (WIN ? execFileSync("bash", ["-c", `cygpath -w "${posix(p)}"`], { encoding: "utf8" }).trim() : p);
const bashDir = () => winPath(execFileSync("bash", ["-c", 'dirname "$(command -v bash)"'], { encoding: "utf8" }).trim());

const KEY = "dashboard-key-for-this-test-only-0123456789";
const COMMS = { endpoint: NOWHERE, mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }] };
const STDIO = {
  endpoint: "http://127.0.0.2:9700",
  credentialRef: "aify-dashboard.key",
  sessionInject: { mcp: true },
  mcp: [{ name: "aify-dashboard", command: "node", args: ["--experimental-strip-types", "/d/bridge/main.ts", "serve"] }],
};
const HTTP = { ...STDIO, mcpTransport: "http" };
const raw = (dashboard, comms = COMMS) => ({ version: 1, services: { "aify-comms": comms, "aify-dashboard": dashboard } });
/** The registry as the code reads it: parsed, so every field has its default. */
const registryWith = (dashboard, comms) => parseRegistry(JSON.stringify(raw(dashboard, comms))).registry;
const LAUNCH = { agentId: "agent-one", machineId: "win32:host-a", folder: "C:/work/alpha", keys: { "aify-dashboard": KEY }, ownEndpoint: "http://127.0.0.3:8800" };

test("the services reached over HTTP are the launcher's own when it is named, then each other one declaring http", () => {
  // Bug this catches: comms' own tools left out of the generic entry (it declares no sessionInject), or a service
  // that never asked for every session given one.
  const services = sessionHttpServices(registryWith(HTTP), { own: "aify-comms" });
  assert.deepEqual(services.map((s) => [s.name, s.own]), [["aify-comms", true], ["aify-dashboard", false]]);
  assert.deepEqual(services[1], { name: "aify-dashboard", endpoint: "http://127.0.0.2:9700", credentialRef: "aify-dashboard.key", keyEnv: [], own: false });
  assert.deepEqual(sessionHttpServices(registryWith(HTTP)).map((s) => s.name), ["aify-dashboard"], "the own service came without being named");
  // Control: without the declaration, nothing is reached over HTTP.
  assert.equal(reachedOverHttp(registryWith(STDIO).services["aify-dashboard"]), false);
  assert.equal(reachedOverHttp({ ...registryWith(HTTP).services["aify-dashboard"], sessionInject: { mcp: false } }), false);
  assert.deepEqual(sessionHttpServices(registryWith(STDIO)), []);
  assert.equal(sessionHttpBase64(registryWith(STDIO)), "", "a host with no HTTP service bakes something");
});

test("the baked list reads back as written, and anything else is refused rather than guessed at", () => {
  const baked = sessionHttpBase64(registryWith(HTTP), { own: "aify-comms" });
  assert.deepEqual(sessionHttpFromBase64(baked), sessionHttpServices(registryWith(HTTP), { own: "aify-comms" }));
  assert.deepEqual(sessionHttpFromBase64(""), []);
  for (const bad of ["not base64 json", Buffer.from(JSON.stringify([{ name: "x" }])).toString("base64"), Buffer.from("{}").toString("base64")]) {
    assert.throws(() => sessionHttpFromBase64(bad), undefined, bad);
  }
});

test("each service gets one entry at its /mcp/http with the four agreed headers, its own at the launch's endpoint", () => {
  const services = sessionHttpServices(registryWith(HTTP), { own: "aify-comms" });
  assert.equal(sessionEndpoint(services[0], LAUNCH.ownEndpoint), "http://127.0.0.3:8800");
  assert.deepEqual(claudeHttpServers(services, LAUNCH), {
    "aify-comms": {
      type: "http", url: "http://127.0.0.3:8800/mcp/http",
      headers: { "X-Aify-Agent-Id": "agent-one", "X-Aify-Machine-Id": "win32:host-a", "X-Aify-Launch-Folder": "C:/work/alpha" },
    },
    "aify-dashboard": {
      type: "http", url: "http://127.0.0.2:9700/mcp/http",
      headers: { "X-Aify-Agent-Id": "agent-one", "X-Aify-Machine-Id": "win32:host-a", "X-Aify-Launch-Folder": "C:/work/alpha", "X-API-Key": KEY },
    },
  });
  // A launch nobody named still gets the tools, with no agent header; the service then answers reads and refuses writes.
  const unnamed = claudeHttpServers(services, { ...LAUNCH, agentId: "" })["aify-dashboard"].headers;
  assert.equal("X-Aify-Agent-Id" in unnamed, false);
});

test("a service reached over HTTP leaves the stdio entries for Claude and Hermes, and keeps them for Codex", () => {
  // Bug this catches: the session getting both the local process and the HTTP entry under one name, or Codex, whose
  // header support is not observed, losing the tools.
  assert.deepEqual(sessionMcpEntriesFor(registryWith(HTTP)), []);
  const hermes = sessionHermesEntries(registryWith(HTTP));
  assert.equal(hermes.ok, true);
  assert.deepEqual(hermes.entries, []);
  assert.match(sessionCodexWords(registryWith(HTTP)).words.join(" "), /aify-dashboard/);
  // Control: without the declaration, the stdio entries are there for Claude and Hermes.
  assert.equal(sessionMcpEntriesFor(registryWith(STDIO)).length, 1);
  assert.equal(sessionHermesEntries(registryWith(STDIO)).entries.length, 1);
});

test("Hermes' entry names only variables hermes-aify sets, writes the machine id and key as they are, and goes keyless without one", () => {
  // Bug this catches: a `${...}` hermes-aify does not set, which makes Hermes refuse the whole server; or a keyless
  // service dropped from Hermes while Claude keeps it.
  const result = hermesHttpEntries(registryWith(HTTP), { machineId: "win32:host-a", keys: { "aify-dashboard": KEY } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, [{
    name: "aify-dashboard",
    value: {
      url: "http://127.0.0.2:9700/mcp/http",
      headers: { "X-Aify-Agent-Id": "${AIFY_AGENT_ID}", "X-Aify-Machine-Id": "win32:host-a", "X-Aify-Launch-Folder": "${workspaceFolder}", "X-API-Key": KEY },
      "x-aify-owner": "aify-wrapper",
    },
  }]);
  const keyless = hermesHttpEntries(registryWith(HTTP), { machineId: "win32:host-a", keys: {} });
  assert.equal(keyless.ok, true);
  assert.equal("X-API-Key" in keyless.entries[0].value.headers, false);
  const expanding = hermesHttpEntries(registryWith(HTTP), { machineId: "win32:host-a", keys: { "aify-dashboard": "a${HOME}b" } });
  assert.equal(expanding.ok, false);
});

test("the installer bakes the HTTP list, with its own service only when it names it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-http-cli-"));
  const file = path.join(dir, "services.json");
  const baked = (...own) => sessionHttpFromBase64(execFileSync(process.execPath, [REGISTRY_CLI, "session-http-b64", file, ...own], { encoding: "utf8" }));
  fs.writeFileSync(file, JSON.stringify(raw(HTTP)));
  assert.deepEqual(baked().map((s) => s.name), ["aify-dashboard"]);
  assert.deepEqual(baked("aify-comms").map((s) => s.name), ["aify-comms", "aify-dashboard"]);
  fs.writeFileSync(file, JSON.stringify(raw(STDIO)));
  assert.deepEqual(baked(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the installer's hermes step writes the HTTP entry through hermes' own config set, and says a running hermes reloads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-http-hermes-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify(raw(HTTP)));
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ "aify-dashboard": { command: "old", "x-aify-owner": "aify-wrapper" } }));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");
  const home = path.join(dir, "home");
  writePrivateCredential(home, "aify-dashboard.key", KEY);
  fs.mkdirSync(path.join(dir, "hermes", "installs", "another"), { recursive: true });
  const env = {
    ...process.env, HERMES_HOME: path.join(dir, "hermes"), LOCALAPPDATA: path.join(dir, "local"), HOME: home, USERPROFILE: home,
    HERMES_RUNTIME_COMMAND: FAKE_HERMES, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: log, FAKE_HERMES_MODE: "", AIFY_MACHINE_ID: "host-a",
  };
  delete env.HERMES_DATA_DIR_SUFFIX;
  const run = spawnSync(process.execPath, [HERMES_CLI, "--write-now", registry], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const after = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.equal(after["aify-dashboard"].url, "http://127.0.0.2:9700/mcp/http");
  assert.equal(after["aify-dashboard"].headers["X-API-Key"], KEY);
  assert.equal(after["aify-dashboard"].headers["X-Aify-Launch-Folder"], "${workspaceFolder}");
  assert.match(after["aify-dashboard"].headers["X-Aify-Machine-Id"], /:host-a$/);
  assert.equal(after["aify-dashboard"].command, undefined, "the old stdio entry's command survived the rewrite");
  assert.match(run.stdout, /running hermes agent reloads these servers/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Render claude against `registry`, launch it from its own folder with a stub runtime, and return what it was handed.
 * `again` launches into an earlier launch's folder and home; `first` is a line the stub runs before anything else.
 */
function launch(registry, { withKey = true, env = {}, again = null, first = "", status = 0 } = {}) {
  const dir = again ?? fs.mkdtempSync(path.join(os.tmpdir(), "aify-http-launch-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const cwd = path.join(dir, "work");
  const home = path.join(dir, "home");
  for (const d of [out, stubs, cwd, home, path.join(dir, "bridge")]) fs.mkdirSync(d, { recursive: true });
  if (withKey && !again) writePrivateCredential(home, "aify-dashboard.key", KEY);
  for (const f of fs.readdirSync(dir).filter((name) => name.startsWith("captured."))) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, "bridge", "claude-channel.js"), "");
  const registryFile = path.join(dir, "services.json");
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  readerWrapper(path.join(dir, "wrapper"));
  renderWorld("claude", dir, out);

  const captured = path.join(dir, "captured");
  fs.writeFileSync(path.join(stubs, "claude"), [
    "#!/bin/sh",
    "n=0",
    'while [ $# -gt 0 ]; do',
    '  case "$1" in --mcp-config=*) n=$((n+1)); _f="${1#--mcp-config=}"' + `; cp "$_f" "${posix(captured)}.$n.json"; printf '%s\\n' "$_f" > "${posix(captured)}.$n.path" ;; esac`,
    "  shift",
    "done",
    first,
    "exit 0",
    "",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(path.join(stubs, "claude"), 0o755);

  const run = spawnSync("bash", [path.join(out, "claude-aify")], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: [winPath(stubs), path.dirname(process.execPath), bashDir()].join(SEP), HOME: posix(home), USERPROFILE: home, ...ownerEnv(),
      AIFY_MACHINE_ID: "host-a", ...definitionsEnv(path.join(dir, "defs")), HARNESS_IDENTITY: "probe-agent", ...env,
    },
    timeout: 60_000,
  });
  if (status === "killed") assert.notEqual(run.status, 0, "the launcher was not killed");
  else assert.equal(run.status, status, `launcher exited ${run.status}: ${run.stdout}\n${run.stderr}`);
  const configs = [];
  for (let n = 1; fs.existsSync(`${captured}.${n}.json`); n += 1) {
    configs.push({ config: JSON.parse(fs.readFileSync(`${captured}.${n}.json`, "utf8")), passed: fs.readFileSync(`${captured}.${n}.path`, "utf8").trim() });
  }
  return { configs, stderr: run.stderr, cwd, dir, home };
}

test("a Claude launch gets the HTTP entry as its agent, from its folder, in its agent's owner-only session file", async () => {
  // Bug this catches: the key written where the session's temp grants others Modify (22 such files piled up on this host).
  const { configs, cwd, dir, home } = launch(raw(HTTP));
  assert.equal(configs.length, 1, JSON.stringify(configs));
  const [{ config, passed }] = configs;
  const headers = config.mcpServers["aify-dashboard"].headers;
  assert.equal(config.mcpServers["aify-dashboard"].type, "http");
  assert.equal(headers["X-Aify-Agent-Id"], "probe-agent");
  assert.equal(path.resolve(headers["X-Aify-Launch-Folder"]), path.resolve(cwd));
  assert.match(headers["X-Aify-Machine-Id"], /:host-a$/);
  assert.equal(headers["X-API-Key"], KEY);
  const file = path.join(home, ".aify", "sessions", "probe-agent", "mcp.json");
  assert.equal(path.resolve(WIN ? winPath(passed) : passed), path.resolve(file));
  assert.equal(await folderCustodyProblemFor(path.dirname(file)), "", "the folder holding the key is not its owner's alone");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a launch into a widened sessions folder refuses (78) rather than write the key there", () => {
  const first = launch(raw(HTTP));
  const sessions = path.join(first.home, ".aify", "sessions");
  if (WIN) execFileSync("icacls", [sessions, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "ignore", windowsHide: true });
  else fs.chmodSync(path.join(sessions, "probe-agent"), 0o755);
  const refused = launch(raw(HTTP), { again: first.dir, status: 78 });
  assert.equal(refused.configs.length, 0, "claude was started anyway");
  assert.match(refused.stderr, /readable by|grants access beyond/);
  fs.rmSync(first.dir, { recursive: true, force: true });
});

test("a launcher killed mid-session leaves its agent's one file, which the next launch replaces", () => {
  // TerminateProcess, as aify-env stops one: the stub kills its launcher outright, so no trap runs.
  const killed = launch(raw(HTTP), { first: "kill -9 $PPID", status: "killed" });
  const folder = path.join(killed.home, ".aify", "sessions", "probe-agent");
  assert.deepEqual(fs.readdirSync(folder), ["mcp.json"]);
  launch(raw(HTTP), { again: killed.dir });
  launch(raw(HTTP), { again: killed.dir, first: "kill -9 $PPID", status: "killed" });
  assert.deepEqual(fs.readdirSync(folder), ["mcp.json"], "kills piled up files");
  fs.rmSync(killed.dir, { recursive: true, force: true });
});

test("stdio and HTTP session servers share the one file, and strict mode carries neither", () => {
  // Bug this catches: two per-session files where one would do, or strict mode, which exists to keep extra servers
  // out of the session, handed a service that is not its own.
  const stdioToo = { ...STDIO, credentialRef: "aify-other.key", mcp: [{ name: "aify-other", command: "node", args: ["/o.js"] }] };
  const both = { version: 1, services: { "aify-comms": COMMS, "aify-dashboard": HTTP, "aify-other": stdioToo } };
  const { configs, dir } = launch(both);
  assert.equal(configs.length, 1, JSON.stringify(configs));
  assert.deepEqual(Object.keys(configs[0].config.mcpServers).sort(), ["aify-dashboard", "aify-other"]);
  assert.equal(configs[0].config.mcpServers["aify-other"].command, "node");
  fs.rmSync(dir, { recursive: true, force: true });
  const strict = launch(both, { env: { AIFY_CLAUDE_STRICT_MCP: "1" } });
  assert.equal(strict.configs.some(({ config }) => "aify-dashboard" in config.mcpServers || "aify-other" in config.mcpServers), false,
    JSON.stringify(strict.configs));
  fs.rmSync(strict.dir, { recursive: true, force: true });
});

test("a Claude launch whose HTTP service has no key keeps the entry without X-API-Key, and says so", () => {
  // Bug this catches: a keyless service dropped from the session (tools silently absent), or its launch stopped.
  const { configs, stderr, dir } = launch(raw(HTTP), { withKey: false });
  assert.equal(configs.length, 1, JSON.stringify(configs));
  assert.equal("X-API-Key" in configs[0].config.mcpServers["aify-dashboard"].headers, false);
  assert.match(stderr, /aify-dashboard: no key found \(.*\); the service decides/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Claude launch whose service declares no http gets the stdio entry as before", () => {
  const { configs, stderr, dir } = launch(raw(STDIO));
  assert.equal(configs.length, 1);
  assert.equal(configs[0].config.mcpServers["aify-dashboard"].command, "node");
  assert.doesNotMatch(stderr, /no key found/, "a launch with no HTTP service looked for a key");
  fs.rmSync(dir, { recursive: true, force: true });
});
