#!/usr/bin/env node
// Per-session MCP in the DEFAULT mode: a service that opts in with `sessionInject: { mcp: true }` reaches every
// Claude session the launcher starts, without anything being written to ~/.claude.json.
//
// WHY PER SESSION. ~/.claude.json is rewritten by running sessions, so an installer that edits it races them. A
// per-session `--mcp-config` file, passed WITHOUT `--strict-mcp-config`, adds servers beside the user's own. That
// loading was proven on Claude Code 2.1.278, 2026-09-19 (aify-dashboard DESIGN-INTEGRATION.md).
//
// WHAT MUST NOT CHANGE. A host that opted nothing in gets exactly the default launch it gets today: no
// `--mcp-config` at all. That is the first test, and it is the one that would catch this feature quietly
// changing every launch for people who never asked for it.
//
// THE KEY NEVER REACHES THE FILE. An opted-in entry may not declare `keyEnv`, because `mcpEntriesFor` resolves it
// to the VALUE (WRAP-M1), refused at parse so it cannot be rendered. A service that opts in reads its key itself,
// from its credential file, as aify-dashboard's bridge does. `endpointEnv` is allowed: an env block is key-scoped
// (registry.mjs, proven on Claude Code 2.1.236), so naming the endpoint does not cost the server AIFY_AGENT_ID.
//
// These run the real installer and the real launcher, with a stub `claude` that records its arguments and copies
// the config it was handed.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerBridge } from "./definition-reader-bridge.mjs";

import { parseRegistry, sessionMcpConfig, sessionMcpConfigBase64, sessionMcpEntriesFor } from "../lib/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const CLI = path.join(ROOT, "lib", "registry-cli.mjs");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32";
const SEP = WIN ? ";" : ":";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const winPath = (p) => (WIN ? execFileSync("bash", ["-c", `cygpath -w "${posix(p)}"`], { encoding: "utf8" }).trim() : p);
const bashDir = () => winPath(execFileSync("bash", ["-c", 'dirname "$(command -v bash)"'], { encoding: "utf8" }).trim());

const COMMS = {
  "aify-comms": {
    endpoint: NOWHERE,
    endpointEnv: ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"],
    mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }],
  },
};

const DASHBOARD = {
  endpoint: "http://127.0.0.2:9700",
  credentialRef: "aify-dashboard.key",
  sessionInject: { mcp: true },
  mcp: [{ name: "aify-dashboard", command: "node", args: ["--experimental-strip-types", "/d/bridge/main.ts", "serve"] }],
};

const registryWith = (services) => ({ version: 1, services: { ...COMMS, ...services } });

/** Render claude against a registry, run it with a stub runtime, and return what the runtime was handed. */
function launch(registry, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-session-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const captured = path.join(dir, "captured.json");
  const argv = path.join(dir, "argv.txt");
  for (const d of [out, stubs, home]) fs.mkdirSync(d, { recursive: true });
  const registryFile = path.join(dir, "services.json");
  fs.writeFileSync(registryFile, JSON.stringify(registry));

  const rendered = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", out, "--registry", registryFile,
    "--bridge-dir", posix(readerBridge(path.join(dir, "bridge")))], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  fs.writeFileSync(path.join(stubs, "claude"), [
    "#!/bin/sh",
    `: > "${posix(argv)}"`,
    'while [ $# -gt 0 ]; do',
    `  printf '%s\\n' "$1" >> "${posix(argv)}"`,
    `  if [ "$1" = "--mcp-config" ]; then cp "$2" "${posix(captured)}"; printf '%s\\n' "$2" > "${posix(captured)}.path"; fi`,
    '  case "$1" in --mcp-config=*) _f="${1#--mcp-config=}" ;; *) _f="" ;; esac',
    `  if [ -n "$_f" ]; then cp "$_f" "${posix(captured)}"; printf '%s\\n' "$_f" > "${posix(captured)}.path"; fi`,
    "  shift",
    "done",
    "exit 0",
    "",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(path.join(stubs, "claude"), 0o755);

  const run = spawnSync("bash", [path.join(out, "claude-aify")], {
    encoding: "utf8",
    env: { PATH: [winPath(stubs), path.dirname(process.execPath), bashDir()].join(SEP), HOME: posix(home),
      ...definitionsEnv(path.join(dir, "defs")), HARNESS_IDENTITY: "probe-agent", ...env },
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `launcher failed: ${run.stdout}\n${run.stderr}`);
  const args = fs.readFileSync(argv, "utf8").split("\n").filter(Boolean);
  const config = fs.existsSync(captured) ? JSON.parse(fs.readFileSync(captured, "utf8")) : null;
  const passedPath = fs.existsSync(`${captured}.path`) ? fs.readFileSync(`${captured}.path`, "utf8").trim() : null;
  return { args, config, passedPath, dir };
}

test("a host that opted nothing in launches exactly as today, with no --mcp-config at all", () => {
  const { args, config, dir } = launch(registryWith({}));
  assert.equal(config, null, "a per-session config was passed although no service opted in");
  assert.ok(!args.some((a) => a === "--mcp-config" || a.startsWith("--mcp-config=")), `--mcp-config was passed: ${args.join(" ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an opted-in service reaches the default-mode session beside the user's own servers, with no env block", () => {
  const { args, config, dir } = launch(registryWith({ "aify-dashboard": DASHBOARD }));
  assert.ok(args.some((a) => a.startsWith("--mcp-config=")), `no --mcp-config= was passed: ${args.join(" ")}`);
  // ⛔ The equals form, never `--mcp-config <file>`. The flag takes several values, and the spaced form reads
  // any bare word after it as a second config path (Claude Code 2.1.286, 2026-10-01; aify-dashboard
  // docs/evidence/wrapper-session-mcp-2026-10-01/variadic.txt). Today `--settings` always follows it, so the
  // equals form is what keeps that safe if a flag is ever appended between them, or the order changes.
  assert.ok(!args.includes("--mcp-config"), "the spelling that swallows a following prompt was used");
  // ⛔ Never strict in the default mode: strict would hide every server the operator configured.
  assert.ok(!args.includes("--strict-mcp-config"), "the default mode was made strict");
  assert.deepEqual(Object.keys(config.mcpServers), ["aify-dashboard"], "the session file carried more than the opted-in server");
  assert.deepEqual(config.mcpServers["aify-dashboard"], { command: "node", args: ["--experimental-strip-types", "/d/bridge/main.ts", "serve"] });
  // A service that declared no endpointEnv gets no env block at all.
  assert.equal(config.mcpServers["aify-dashboard"].env, undefined, "an env block appeared that nothing declared");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the per-session file is removed when the session ends", () => {
  const { passedPath, dir } = launch(registryWith({ "aify-dashboard": DASHBOARD }));
  assert.ok(passedPath !== null, "no file was passed");
  const onDisk = WIN ? winPath(passedPath) : passedPath;
  assert.equal(fs.existsSync(onDisk), false, `the session file outlived the session: ${passedPath}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an opted-in endpointEnv is bound to the endpoint, and nothing else is", () => {
  const { config, dir } = launch(registryWith({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } }));
  assert.deepEqual(config.mcpServers["aify-dashboard"].env, { AIFY_DASHBOARD_URL: "http://127.0.0.2:9700" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("strict mode is untouched: an opted-in session service is not a strict one", () => {
  // Strict and default are different promises (aify-comms' owner, 2026-10-01). Strict carries only `strictMcp`
  // services, because extra servers bring back the init race strict mode exists to avoid.
  const { config, dir } = launch(registryWith({ "aify-dashboard": DASHBOARD }), { AIFY_CLAUDE_STRICT_MCP: "1" });
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["aify-comms", "aify-comms-channel"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an opted-in entry that declares a key, or a malformed opt-in, is refused at parse", () => {
  const cases = [
    ["keyEnv", { ...DASHBOARD, keyEnv: ["AIFY_DASHBOARD_API_KEY"] }, /keyEnv/],
    ["a string", { ...DASHBOARD, sessionInject: { mcp: "true" } }, /sessionInject\.mcp must be true or false/],
    ["not an object", { ...DASHBOARD, sessionInject: true }, /sessionInject must be an object/],
    ["an unknown key", { ...DASHBOARD, sessionInject: { mcp: true, forwardEnv: [] } }, /sessionInject\.forwardEnv/],
  ];
  for (const [what, entry, reason] of cases) {
    const parsed = parseRegistry(JSON.stringify(registryWith({ "aify-dashboard": entry })));
    assert.equal(parsed.ok, false, `${what} was accepted`);
    assert.match(parsed.errors.join("\n"), reason, `${what}: ${parsed.errors.join("; ")}`);
  }
  // The controls: opting out with a key is today's behaviour, and opting in without one is accepted.
  assert.equal(parseRegistry(JSON.stringify(registryWith({ "aify-dashboard": { ...DASHBOARD, sessionInject: { mcp: false }, keyEnv: ["K"] } }))).ok, true);
  assert.equal(parseRegistry(JSON.stringify(registryWith({ "aify-dashboard": DASHBOARD }))).ok, true);
});

test("the install itself refuses an opted-in entry with a key, and writes no launcher", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-session-refuse-"));
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });
  const registryFile = path.join(dir, "services.json");
  fs.writeFileSync(registryFile, JSON.stringify(registryWith({ "aify-dashboard": { ...DASHBOARD, keyEnv: ["AIFY_DASHBOARD_API_KEY"] } })));
  const refused = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", out, "--registry", registryFile], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.notEqual(refused.status, 0, "the install rendered a launcher for a refused registry");
  assert.match(refused.stderr, /keyEnv/);
  assert.deepEqual(fs.readdirSync(out), [], "a launcher was written despite the refusal");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("session-fragment-b64: empty for no opt-in, the config for one, and 78 for an unusable registry", () => {
  // The contract aify-comms' installer calls (its owner, 2026-10-01): argv, stdout, exit status.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-session-cli-"));
  const file = path.join(dir, "services.json");
  const run = () => spawnSync(process.execPath, [CLI, "session-fragment-b64", file], { encoding: "utf8" });

  fs.writeFileSync(file, JSON.stringify(registryWith({})));
  assert.deepEqual([run().status, run().stdout], [0, ""], "no opt-in did not print the empty string");

  const opted = registryWith({ "aify-dashboard": DASHBOARD });
  fs.writeFileSync(file, JSON.stringify(opted));
  const one = run();
  assert.equal(one.status, 0, one.stderr);
  const parsed = parseRegistry(JSON.stringify(opted));
  assert.equal(one.stdout, sessionMcpConfigBase64(parsed.registry));
  assert.equal(Buffer.from(one.stdout, "base64").toString("utf8"), sessionMcpConfig(parsed.registry));
  assert.ok(!one.stdout.endsWith("\n"), "the value carries a trailing newline into the launcher");

  fs.writeFileSync(file, JSON.stringify(registryWith({ "aify-dashboard": { ...DASHBOARD, keyEnv: ["K"] } })));
  assert.equal(run().status, 78, "an unusable registry did not exit 78");

  fs.rmSync(file);
  assert.deepEqual([run().status, run().stdout], [0, ""], "an absent registry is the empty registry");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sessionMcpEntriesFor: only opted-in services, ordered by service name whatever order the file lists them", () => {
  // Two installs from one registry must render byte-identically, or every reinstall reads as a change.
  // Each needs its own credential file and server name, which the parser requires of any two services.
  const like = (ref, name, mcp) => ({ ...DASHBOARD, credentialRef: ref, sessionInject: { mcp }, mcp: [{ name, command: "node", args: [] }] });
  const parsed = parseRegistry(JSON.stringify(registryWith({
    "zz-svc": like("zz.key", "zz-server", true), "aa-svc": like("aa.key", "aa-server", true), "mm-off": like("mm.key", "mm-server", false),
  })));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(sessionMcpEntriesFor(parsed.registry).map((e) => e.name), ["aa-server", "zz-server"]);
});

test("an opted-in endpointEnv name that ANY service keeps a key in is refused at parse", () => {
  // ⛔ The bug this catches (aify-comms' senior review, 2026-10-01): the keyEnv refusal is per service, so an opted-in
  // entry could name, in endpointEnv, the variable a NEIGHBOUR keeps its key in. Claude binds it to this entry's
  // endpoint, so no key reaches the file, but the bridge's copy of the variable is silently a URL; codex forwards the
  // inherited value. The same registries are refused for both runtimes.
  const neighbour = { "aify-comms": { ...COMMS["aify-comms"], keyEnv: ["SYNTHETIC_CREDENTIAL_VAR"] } };
  const clash = parseRegistry(JSON.stringify({ version: 1, services: { ...neighbour, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["SYNTHETIC_CREDENTIAL_VAR"] } } }));
  assert.equal(clash.ok, false, "a neighbour's key variable was accepted as an endpoint variable");
  assert.match(clash.errors.join("\n"), /"SYNTHETIC_CREDENTIAL_VAR".*aify-comms/);
  // The controls: a distinct name beside the same keyed neighbour, and the same clash on an entry that did not opt in.
  assert.equal(parseRegistry(JSON.stringify({ version: 1, services: { ...neighbour, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } } })).ok, true);
  const unopted = { ...DASHBOARD, sessionInject: { mcp: false }, endpointEnv: ["SYNTHETIC_CREDENTIAL_VAR"] };
  assert.equal(parseRegistry(JSON.stringify({ version: 1, services: { ...neighbour, "aify-dashboard": unopted } })).ok, true, "the rule reached beyond opted-in entries");
});

test("a neighbour's key set in the installing environment reaches neither the document nor the launcher", () => {
  // ⛔ The bug this catches: any path that resolves a key VALUE into what the installer bakes. The neighbour declares
  // keyEnv and is not opted in; the value is set where the installer runs, which is where mcpEntriesFor reads it.
  const SENTINEL_VAR = "SYNTHETIC_NEIGHBOUR_KEY";
  const sentinel = "sentinel-value-that-must-not-be-baked-7f3a";
  process.env[SENTINEL_VAR] = sentinel;
  try {
    const registry = { version: 1, services: { "aify-comms": { ...COMMS["aify-comms"], keyEnv: [SENTINEL_VAR] }, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-session-sentinel-"));
    const file = path.join(dir, "services.json");
    fs.writeFileSync(file, JSON.stringify(registry));
    const verb = spawnSync(process.execPath, [CLI, "session-fragment-b64", file], { encoding: "utf8" });
    assert.equal(verb.status, 0, verb.stderr);
    const document = Buffer.from(verb.stdout, "base64").toString("utf8");
    assert.ok(!document.includes(sentinel), "the neighbour's key is in the session document");
    // The positive control on this instrument: the document does hold the value it should, the endpoint.
    assert.ok(document.includes("http://127.0.0.2:9700"), "the document read is not the session document");

    const { dir: launched } = launch(registry);
    const launcher = fs.readFileSync(path.join(launched, "out", "claude-aify"), "utf8");
    assert.ok(!launcher.includes(sentinel), "the neighbour's key is baked into the launcher");
    // ⛔ And not baked ENCODED either (the senior review, 2026-10-01): the launcher carries base64 payloads, and a
    // sentinel inside one would pass a raw-text check. Every base64 run is decoded and searched. The positive control
    // is that one decoded run IS the session document, so the decoder can find what is there.
    const decoded = [...launcher.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].map((m) => Buffer.from(m[0], "base64").toString("utf8"));
    assert.ok(decoded.every((text) => !text.includes(sentinel)), "the neighbour's key is baked into the launcher in base64");
    assert.ok(decoded.some((text) => text.includes('"aify-dashboard"') && text.includes("http://127.0.0.2:9700")), "the decoder found no session document, so it cannot be trusted to find a key");
    assert.ok(launcher.includes(Buffer.from(sessionMcpConfig(parseRegistry(JSON.stringify(registry)).registry)).toString("base64")), "the launcher read does not carry the session document");
    fs.rmSync(launched, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    delete process.env[SENTINEL_VAR];
  }
});

test("an unknown key at entry level is accepted and dropped, so services can carry fields this parser does not read", () => {
  // aify-env reads `advertise` from the same file; this parser must not refuse it. Unknown keys INSIDE sessionInject
  // are refused, because that object is this package's to define.
  const withAdvertise = parseRegistry(JSON.stringify(registryWith({ "aify-dashboard": { ...DASHBOARD, advertise: false } })));
  assert.equal(withAdvertise.ok, true, withAdvertise.errors.join("; "));
  assert.equal("advertise" in withAdvertise.registry.services["aify-dashboard"], false, "a field this parser does not own was kept");
  const inside = parseRegistry(JSON.stringify(registryWith({ "aify-dashboard": { ...DASHBOARD, sessionInject: { mcp: true, advertise: false } } })));
  assert.equal(inside.ok, false);
});

test("a neighbour's key variable in another case is refused too, through the real CLI", () => {
  // ⛔ The bug this catches (the senior reviewer's C3, 2026-10-01): a native Windows environment folds case, so a key
  // kept in `synthetic_credential_var` and an opted-in endpointEnv `SYNTHETIC_CREDENTIAL_VAR` are one variable there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-session-alias-"));
  const file = path.join(dir, "services.json");
  const verb = (services) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, services }));
    return spawnSync(process.execPath, [CLI, "session-fragment-b64", file], { encoding: "utf8" });
  };
  const holder = { "aify-comms": { ...COMMS["aify-comms"], keyEnv: ["synthetic_credential_var"] } };
  const alias = verb({ ...holder, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["SYNTHETIC_CREDENTIAL_VAR"] } });
  assert.deepEqual([alias.status, alias.stdout], [78, ""], "an endpoint variable aliasing a neighbour's key was accepted");
  assert.match(alias.stderr, /"SYNTHETIC_CREDENTIAL_VAR".*aify-comms/);
  // The control: a distinct name beside the same lower-case holder.
  const distinct = verb({ ...holder, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } });
  assert.equal(distinct.status, 0, distinct.stderr);
  assert.notEqual(distinct.stdout, "");
  fs.rmSync(dir, { recursive: true, force: true });
});
