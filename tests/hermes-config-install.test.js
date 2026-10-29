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

import { DIGEST_KEY, entryDigest, hermesRoots, installHermesEntries, pendingUpdateMarkers, planHermesEntries, unexpandedHomeProblem } from "../lib/hermes-config-install.mjs";
import { configPlan, configStep, PendingHermesConfig, pendingMarkerPath, PLAN_CHANGES } from "../lib/hermes-pending-config.mjs";

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
// What hermes holds once ENTRY is written: the entry and the digest of it.
const WRITTEN = { ...ENTRY, [DIGEST_KEY]: entryDigest(ENTRY) };

// The writer, as the pending change's step runs it (`--write-now`), unless a case asks for another mode.
// `recorded` records a pending change first, for this registry (true) or the one named, and the marker is read after.
function install({ services = { "aify-dashboard": DASHBOARD }, servers = {}, mode = "", marker = false, hermesHome, cliMode = "--write-now", recorded } = {}) {
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
    ...process.env, HERMES_HOME: hermesHome ?? home, LOCALAPPDATA: path.join(dir, "local"), HOME: dir, USERPROFILE: dir,
    HERMES_RUNTIME_COMMAND: FAKE, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: log, FAKE_HERMES_MODE: mode,
  };
  delete env.HERMES_DATA_DIR_SUFFIX;
  const pending = new PendingHermesConfig({ marker: pendingMarkerPath(dir) });
  if (recorded) pending.record(recorded === true ? registry : path.join(dir, recorded), path.resolve(env.HERMES_HOME, "config.yaml"));
  const run = spawnSync(process.execPath, [CLI, ...(cliMode ? [cliMode] : []), registry], { encoding: "utf8", env, timeout: 60_000 });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const after = JSON.parse(fs.readFileSync(state, "utf8"));
  const left = pending.read().state;
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, calls, after, pending: left };
}
const verbs = (calls) => calls.map((call) => `${call[1]} ${call[2]}`);

test("an absent entry is written, through hermes' own config set, as the verb built it", () => {
  const { run, calls, after } = install();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(verbs(calls), ["get mcp_servers", "get mcp_servers.aify-dashboard", "set mcp_servers.aify-dashboard"]);
  assert.deepEqual(after["aify-dashboard"], WRITTEN);
  assert.match(run.stdout, /wrote aify-dashboard; removed nothing/);
});

test("an entry this installer wrote is rewritten when it differs, or carries no digest, as one written before digests did", () => {
  for (const old of [{ command: "old", ...MARK, [DIGEST_KEY]: entryDigest({ command: "old", ...MARK }) }, ENTRY]) {
    const { run, calls, after } = install({ servers: { "aify-dashboard": old } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(verbs(calls).includes("set mcp_servers.aify-dashboard"), JSON.stringify(old));
    assert.deepEqual(after["aify-dashboard"], WRITTEN);
  }
});

test("AN INSTALL THAT CHANGES NOTHING WRITES NOTHING: the entry it wrote, read back through hermes' get, is not set again", () => {
  // Every set makes hermes rewrite the whole file; a live reinstall turned CRLF into LF for identical content.
  const first = install();
  assert.deepEqual(verbs(first.calls).filter((verb) => verb.startsWith("set")), ["set mcp_servers.aify-dashboard"], "control: the first install wrote nothing");
  const again = install({ servers: first.after });
  assert.equal(again.run.status, 0, again.run.stderr);
  assert.deepEqual(verbs(again.calls), ["get mcp_servers", "get mcp_servers.aify-dashboard"]);
  assert.deepEqual(again.after, first.after);
  assert.match(again.run.stdout, /wrote nothing; removed nothing/);
  assert.doesNotMatch(again.run.stdout, /reloads these servers/);
});

test("--plan says whether an install would write anything, and writes nothing", () => {
  const absent = install({ cliMode: "--plan" });
  assert.equal(absent.run.status, PLAN_CHANGES, absent.run.stderr);
  assert.deepEqual(verbs(absent.calls), ["get mcp_servers", "get mcp_servers.aify-dashboard"]);
  assert.equal(install({ cliMode: "--plan", servers: { "aify-dashboard": WRITTEN } }).run.status, 0);
  assert.equal(install({ cliMode: "--plan", servers: { "aify-dashboard": WRITTEN, old: { command: "x", ...MARK } } }).run.status, PLAN_CHANGES,
    "an entry of ours to remove is a change");
  assert.equal(install({ cliMode: "--plan", servers: { "aify-dashboard": { command: "theirs" } } }).run.status, 78);
});

test("planHermesEntries reads with get alone: what to set, what to remove, and no set or unset made", () => {
  const asked = [];
  const servers = { "aify-dashboard": { command: "old", ...MARK }, gone: { command: "x", ...MARK } };
  const run = (args) => {
    asked.push(args.slice(0, 3).join(" "));
    const name = args[2] === "mcp_servers" ? null : args[2].replace("mcp_servers.", "");
    const found = name === null ? servers : servers[name];
    if (!found) return { status: 1, stdout: "", stderr: `Config key not set: ${args[2]}` };
    return { status: 0, stdout: `${Object.entries(found).map(([key, value]) => (name === null ? `${key}:\n  x-aify-owner: aify-wrapper` : `${key}: ${value}`)).join("\n")}\n`, stderr: "" };
  };
  const plan = planHermesEntries({ entries: [{ name: "aify-dashboard", value: ENTRY }], run, markers: [] });
  assert.deepEqual(plan, { ok: true, toWrite: [{ name: "aify-dashboard", value: WRITTEN }], toRemove: ["gone"] });
  assert.deepEqual(asked, ["config get mcp_servers", "config get mcp_servers.aify-dashboard"]);
});

test("configPlan and configStep, as the pending change runs them: the plan answers without writing, the step writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-step-fns-"));
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-dashboard": DASHBOARD } }));
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, "{}");
  fs.mkdirSync(path.join(dir, "hermes", "installs", "another"), { recursive: true });
  // They run the CLI with this process's environment, as the launcher's and installer's do.
  const vars = { HERMES_HOME: path.join(dir, "hermes"), HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, "local"),
    HERMES_RUNTIME_COMMAND: FAKE, FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: path.join(dir, "calls.log"), FAKE_HERMES_MODE: "" };
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    assert.deepEqual(configPlan(registry), { ok: true, current: false, detail: "" });
    assert.equal(fs.readFileSync(state, "utf8"), "{}", "the plan wrote");
    assert.deepEqual(configStep(registry), { ok: true, detail: "" });
    assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8"))["aify-dashboard"], WRITTEN);
    assert.deepEqual(configPlan(registry), { ok: true, current: true, detail: "" });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("THE INSTALL STEP INTO A CONFIG ALREADY HOLDING ITS SERVERS writes nothing and records nothing, whatever runs here", () => {
  // aify-comms' installer runs this form too. Nothing is scanned: a config that is current needs no quiet host.
  const current = install({ cliMode: "", servers: { "aify-dashboard": WRITTEN } });
  assert.equal(current.run.status, 0, current.run.stderr);
  assert.deepEqual(verbs(current.calls), ["get mcp_servers", "get mcp_servers.aify-dashboard"]);
  assert.match(current.run.stdout, /hermes config: the config already holds these servers\n/);
  assert.equal(current.pending, "none");
  const stale = install({ cliMode: "", servers: { "aify-dashboard": WRITTEN }, recorded: true });
  assert.match(stale.run.stdout, /already holds these servers; the change recorded at .* is retired/);
  assert.equal(stale.pending, "none");
  assert.equal(install({ cliMode: "", servers: { "aify-dashboard": WRITTEN }, recorded: "another.json" }).pending, "pending",
    "a change recorded for another registry was retired");
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

test("every entry is read and decided before anything is written, so a refusal leaves the config as it was", () => {
  // The bug this catches: deciding and writing entry by entry. With two opted-in servers, the first was written and an
  // old entry of ours removed before the second turned out to be the operator's, so a refused install changed the
  // config anyway.
  const services = { "aify-dashboard": { ...DASHBOARD, mcp: [
    { name: "aify-dashboard", command: "node", args: ["/d/bridge.mjs"] },
    { name: "zz-second", command: "node", args: ["/d/second.mjs"] },
  ] } };
  const servers = { "old-service": { command: "old", ...MARK }, "zz-second": { command: "theirs" } };
  const { run, calls, after } = install({ services, servers });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /failed at hermes config get mcp_servers\.zz-second/);
  assert.deepEqual(after, servers, "a refused install changed the config");
  assert.ok(!verbs(calls).some((call) => /^(set|unset)/.test(call)), verbs(calls).join(", "));
});

test("our mark is read inside its own entry only, never carried into the entry above it", () => {
  // The bug this catches (the senior reviewer, dfb2521): a top-level name the reader did not recognise, such as
  // `old.service:`, left the previous name current, so ITS mark was credited to the operator's entry above it, which
  // was then removed. Valid YAML, from an older install or the operator.
  const servers = { operator: { command: "theirs" }, "old.service": { command: "old", ...MARK } };
  const { run, calls, after } = install({ services: {}, servers });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!verbs(calls).includes("unset mcp_servers.operator"), verbs(calls).join(", "));
  assert.deepEqual(Object.keys(after).sort(), ["old.service", "operator"]);
});

test("a write that answers with a warning is not reported as written", () => {
  // set and unset are held to the rule get is: exit 0 AND an empty stderr. What a warning means is unknown, so the
  // step says it cannot vouch for that write rather than reporting it done.
  for (const servers of [{}, { "old-service": { command: "old", ...MARK } }]) {
    const { run } = install({ mode: "warn-write", servers, services: Object.keys(servers).length ? {} : undefined });
    assert.equal(run.status, 78, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /failed at hermes config (set|unset) mcp_servers\./);
    assert.match(run.stderr, /cannot say whether it was written|cannot say whether it was removed/);
  }
});

test("a HERMES_HOME written with ~ or variable syntax refuses the update check rather than looking in the wrong place", () => {
  // Hermes expands ~ and $VAR / %VAR% in HERMES_HOME (hermes_constants.py _expand_hermes_home); this reads the text as
  // written, so it would look for markers under a directory hermes never uses. Refused, never expanded: a second
  // expander is a second parser of hermes' rule.
  for (const home of ["~/hermes", "$HOME/hermes", "%LOCALAPPDATA%\hermes", "C:/x/${H}"]) {
    assert.match(unexpandedHomeProblem({ HERMES_HOME: home }) ?? "", /HERMES_HOME/, home);
  }
  // The controls: a plain path and no HERMES_HOME at all are not refused.
  assert.equal(unexpandedHomeProblem({ HERMES_HOME: "C:/Users/me/AppData/Local/hermes" }), null);
  assert.equal(unexpandedHomeProblem({}), null);
});

test("the installer refuses a HERMES_HOME it cannot read as written, before any hermes command", () => {
  const { run, calls } = install({ hermesHome: "~/hermes" });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /failed at hermes update check:\s+HERMES_HOME \(~\/hermes\)/);
  assert.deepEqual(calls, [], "a hermes command was started");
});
