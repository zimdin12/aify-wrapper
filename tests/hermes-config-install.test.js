#!/usr/bin/env node
// The installer's hermes step (lib/hermes-config-cli.mjs over lib/hermes-config-install.mjs), run as a process against
// tests/fake-hermes.mjs, which answers in the shapes real hermes 0.21.5 was measured to use. Every case owns its
// HERMES_HOME, LOCALAPPDATA and HOME, so no real hermes, config or install state is read or written.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { hermesRoots, installHermesEntries, pendingUpdateMarkers } from "../lib/hermes-config-install.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "lib", "hermes-config-cli.mjs");
const FAKE = path.join(HERE, "fake-hermes.mjs");
const MARK = { "x-aify-owner": "aify-wrapper" };

const DASHBOARD = {
  endpoint: "http://127.0.0.2:9700",
  sessionInject: { mcp: true },
  mcp: [{ name: "aify-dashboard", command: "node", args: ["/d/bridge.mjs"] }],
};
const ENTRY = { command: "node", args: ["/d/bridge.mjs"], env: { AIFY_AGENT_ID: "${AIFY_AGENT_ID}" }, ...MARK };

function install({ services = { "aify-dashboard": DASHBOARD }, servers = {}, mode = "", marker = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-step-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services }));
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify(servers));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");
  const home = path.join(dir, "hermes");
  if (marker) {
    fs.mkdirSync(path.join(home, "installs", "0123456789abcdef"), { recursive: true });
    fs.writeFileSync(path.join(home, "installs", "0123456789abcdef", "source-completion-pending"), "source update tail not finished\n");
  }
  fs.mkdirSync(path.join(home, "installs", "another"), { recursive: true });
  const env = {
    ...process.env, HERMES_HOME: home, LOCALAPPDATA: path.join(dir, "local"), HOME: dir, USERPROFILE: dir,
    HERMES_RUNTIME_COMMAND: FAKE, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: log, FAKE_HERMES_MODE: mode,
  };
  delete env.HERMES_DATA_DIR_SUFFIX;
  const run = spawnSync(process.execPath, [CLI, registry], { encoding: "utf8", env, timeout: 60_000 });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const after = JSON.parse(fs.readFileSync(state, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, calls, after };
}
const verbs = (calls) => calls.map((call) => `${call[1]} ${call[2]}`);

test("an absent entry is written, through hermes' own config set, as the verb built it", () => {
  const { run, calls, after } = install();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(verbs(calls), ["get mcp_servers", "get mcp_servers.aify-dashboard", "set mcp_servers.aify-dashboard"]);
  assert.deepEqual(after["aify-dashboard"], ENTRY);
  assert.match(run.stdout, /wrote aify-dashboard; removed nothing/);
});

test("an entry this installer wrote is rewritten", () => {
  const { run, after } = install({ servers: { "aify-dashboard": { command: "old", ...MARK } } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(after["aify-dashboard"], ENTRY);
});

test("a same-named entry the operator wrote is refused and left exactly as it was", () => {
  // The bug this catches: replacing it. A same-name write over the operator's server is the data loss the mark exists
  // to prevent.
  const theirs = { command: "their-own", args: ["x"] };
  const { run, calls, after } = install({ servers: { "aify-dashboard": theirs } });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /failed at hermes config get mcp_servers\.aify-dashboard/);
  assert.match(run.stderr, /did not write/);
  assert.deepEqual(after["aify-dashboard"], theirs);
  assert.ok(!verbs(calls).some((call) => call.startsWith("set")), verbs(calls).join(", "));
});

test("an answer hermes gives from a config it could not parse is refused, never written over", () => {
  // Hermes exits 0 on an unparseable config and answers from its last good read; only its stderr says so. An entry
  // must exist for that exit-0 answer to happen at all: with none, the fake (like hermes) says "not set" with exit 1,
  // and a check that trusted exit 0 would never be asked (the plant `exit-zero-trusted` stayed green on that fixture).
  const { run, calls } = install({ mode: "broken", servers: { "aify-dashboard": { command: "old", ...MARK } } });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /failed at hermes config get mcp_servers:/);
  assert.ok(!verbs(calls).some((call) => call.startsWith("set")), verbs(calls).join(", "));
});

test("a hermes that fails is refused, with the step named", () => {
  const { run, calls } = install({ mode: "fail" });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /failed at hermes config get mcp_servers:\s+hermes did not give a readable answer \(exit 2\)/);
  assert.equal(calls.length, 1);
});

test("an interrupted hermes update refuses before any hermes command is started", () => {
  // Any hermes command run while the marker exists re-runs that update; the install must not be what trips it.
  const { run, calls } = install({ marker: true });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /failed at hermes update check/);
  assert.match(run.stderr, /source-completion-pending/);
  assert.match(run.stderr, /not elevated/);
  assert.deepEqual(calls, [], "a hermes command was started");
});

test("an entry of ours no service opts into any more is removed, and the operator's are not", () => {
  const { run, after } = install({ services: {}, servers: { "old-service": { command: "old", ...MARK }, "their-server": { command: "theirs" } } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(after), ["their-server"]);
  assert.match(run.stdout, /wrote nothing; removed old-service/);
});

test("hermes' roots: the platform default, a HERMES_HOME under it, a custom one, and a profile's root", () => {
  const facts = (env, platform = "win32") => hermesRoots({ env, platform, homedir: "C:/u", join: path.posix.join, dirname: path.posix.dirname, basename: path.posix.basename });
  assert.deepEqual(facts({ LOCALAPPDATA: "C:/u/AppData/Local" }), ["C:/u/AppData/Local/hermes"]);
  assert.deepEqual(facts({ LOCALAPPDATA: "C:/u/AppData/Local", HERMES_HOME: "C:/u/AppData/Local/hermes" }), ["C:/u/AppData/Local/hermes"]);
  assert.deepEqual(facts({ LOCALAPPDATA: "C:/u/AppData/Local", HERMES_HOME: "D:/h" }), ["C:/u/AppData/Local/hermes", "D:/h"]);
  assert.deepEqual(facts({ HERMES_HOME: "/srv/h/profiles/work" }, "linux"), ["C:/u/.hermes", "/srv/h"]);
  assert.deepEqual(facts({ HERMES_DATA_DIR_SUFFIX: "-dev" }, "linux"), ["C:/u/.hermes-dev"]);
});

test("the update check finds a marker in any install under any root, and nothing where there is none", () => {
  // The control the wrapper owner asked for: the scan finds a REAL marker on today's layout. It cannot cover a hermes
  // that moves it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-markers-"));
  const make = (root, install, pending) => {
    fs.mkdirSync(path.join(dir, root, "installs", install), { recursive: true });
    if (pending) fs.writeFileSync(path.join(dir, root, "installs", install, "source-completion-pending"), "x\n");
  };
  make("native", "aaaa", false);
  make("native", "bbbb", true);
  make("custom", "cccc", true);
  fs.mkdirSync(path.join(dir, "empty"));
  const io = {
    readdir: (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
    exists: fs.existsSync,
    join: path.join,
  };
  const found = pendingUpdateMarkers(["native", "custom", "empty"].map((r) => path.join(dir, r)), io);
  assert.deepEqual(found.map((p) => path.relative(dir, p).split(path.sep).join("/")),
    ["native/installs/bbbb/source-completion-pending", "custom/installs/cccc/source-completion-pending"]);
  assert.deepEqual(pendingUpdateMarkers([path.join(dir, "empty")], io), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hermes call that timed out refuses at its step, and nothing is written after it", () => {
  // The CLI reports a call that timed out or could not start as a null status; the process tests above cannot make
  // the stand-in time out, so this calls the step with a runner that does.
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    return args[1] === "get" && args[2] === "mcp_servers.aify-dashboard"
      ? { status: null, stdout: "", stderr: "spawnSync hermes ETIMEDOUT" }
      : { status: 1, stdout: "", stderr: "Config key not set: mcp_servers" };
  };
  const outcome = installHermesEntries({ entries: [{ name: "aify-dashboard", value: ENTRY }], run, markers: [] });
  assert.deepEqual(outcome.ok, false);
  assert.equal(outcome.step, "hermes config get mcp_servers.aify-dashboard");
  assert.match(outcome.problem, /exit null.*ETIMEDOUT/);
  assert.deepEqual(calls, ["config get mcp_servers", "config get mcp_servers.aify-dashboard"]);
});
