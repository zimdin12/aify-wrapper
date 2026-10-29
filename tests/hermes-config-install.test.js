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

import { entryReceipt, hermesRoots, installHermesEntries, pendingUpdateMarkers, planHermesEntries, unexpandedHomeProblem } from "../lib/hermes-config-install.mjs";
import { HermesConfigReceipts, receiptsPath } from "../lib/hermes-config-receipts.mjs";
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

/**
 * The writer, as the pending change's step runs it (`--write-now`), unless a case asks for another mode.
 * `recorded` records a pending change first, for this registry (true) or the one named, and the marker is read after.
 * `written` runs the step once first, in the same home, so the entries and their receipts are in place; `edit` then
 * changes the config behind the receipt, and `writtenHome` is the HERMES_HOME that first step wrote for.
 */
function install({ services = { "aify-dashboard": DASHBOARD }, servers = {}, mode = "", marker = false, hermesHome, cliMode = "--write-now",
  recorded, written = false, edit, writtenHome } = {}) {
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
  if (written) {
    const first = spawnSync(process.execPath, [CLI, "--write-now", registry], { encoding: "utf8", env: { ...env, HERMES_HOME: writtenHome ?? env.HERMES_HOME }, timeout: 60_000 });
    assert.equal(first.status, 0, `control: the first step did not write: ${first.stderr}`);
    if (edit) fs.writeFileSync(state, JSON.stringify(edit(JSON.parse(fs.readFileSync(state, "utf8")))));
    fs.writeFileSync(log, "");
  }
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

test("an absent entry is written, through hermes' own config set, as the verb built it, and read back for its receipt", () => {
  const { run, calls, after } = install();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(verbs(calls), ["get mcp_servers", "get mcp_servers.aify-dashboard", "set mcp_servers.aify-dashboard", "get mcp_servers.aify-dashboard"]);
  assert.deepEqual(after["aify-dashboard"], ENTRY, "the config was given more than the entry");
  assert.match(run.stdout, /wrote aify-dashboard; removed nothing/);
});

test("an entry of ours with no receipt, or not the value it would be given now, is rewritten", () => {
  for (const old of [{ command: "old", ...MARK }, ENTRY]) {
    const { run, calls, after } = install({ servers: { "aify-dashboard": old } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(verbs(calls).includes("set mcp_servers.aify-dashboard"), JSON.stringify(old));
    assert.deepEqual(after["aify-dashboard"], ENTRY);
  }
});

test("AN INSTALL THAT CHANGES NOTHING WRITES NOTHING: an entry hermes answers for as it did after the write is not set again", () => {
  // Every set makes hermes rewrite the whole file; a live reinstall turned CRLF into LF for identical content.
  const again = install({ written: true });
  assert.equal(again.run.status, 0, again.run.stderr);
  assert.deepEqual(verbs(again.calls), ["get mcp_servers", "get mcp_servers.aify-dashboard"]);
  assert.deepEqual(again.after["aify-dashboard"], ENTRY);
  assert.match(again.run.stdout, /wrote nothing; removed nothing/);
  assert.doesNotMatch(again.run.stdout, /reloads these servers/);
});

test("AN ENTRY CHANGED UNDER OUR MARK is not current: the receipt says what hermes answered then, not what it holds now", () => {
  // Review of 72405ab: a stamp kept in the entry read an edited command as current.
  const edited = install({ written: true, edit: (servers) => ({ ...servers, "aify-dashboard": { ...servers["aify-dashboard"], command: "edited" } }) });
  assert.equal(edited.run.status, 0, edited.run.stderr);
  assert.ok(verbs(edited.calls).includes("set mcp_servers.aify-dashboard"), "an entry edited behind its receipt was taken for current");
  assert.deepEqual(edited.after["aify-dashboard"], ENTRY);
});

test("A RECEIPT FOR ONE HERMES CONFIG says nothing about another: a step for a moved HERMES_HOME writes", () => {
  const moved = install({ written: true, writtenHome: path.join(os.tmpdir(), "aify-hermes-other-home") });
  assert.equal(moved.run.status, 0, moved.run.stderr);
  assert.ok(verbs(moved.calls).includes("set mcp_servers.aify-dashboard"), "a receipt for another config was taken for this one's");
});

test("--plan says whether an install would write anything, and writes nothing", () => {
  const absent = install({ cliMode: "--plan" });
  assert.equal(absent.run.status, PLAN_CHANGES, absent.run.stderr);
  assert.deepEqual(verbs(absent.calls), ["get mcp_servers", "get mcp_servers.aify-dashboard"]);
  assert.equal(install({ cliMode: "--plan", written: true }).run.status, 0);
  assert.equal(install({ cliMode: "--plan", servers: { "aify-dashboard": ENTRY } }).run.status, PLAN_CHANGES, "an entry with no receipt is a change");
  assert.equal(install({ cliMode: "--plan", written: true, edit: (servers) => ({ ...servers, old: { command: "x", ...MARK } }) }).run.status, PLAN_CHANGES,
    "an entry of ours to remove is a change");
  assert.equal(install({ cliMode: "--plan", servers: { "aify-dashboard": { command: "theirs" } } }).run.status, 78);
});

test("planHermesEntries reads with get alone: what to set, what to remove, what is kept, and no set or unset made", () => {
  const asked = [];
  const servers = { "aify-dashboard": { command: "old", ...MARK }, gone: { command: "x", ...MARK } };
  const answer = (found) => `${Object.entries(found).map(([key, value]) => `${key}: ${value}`).join("\n")}\n`;
  const run = (args) => {
    asked.push(args.slice(0, 3).join(" "));
    const name = args[2] === "mcp_servers" ? null : args[2].replace("mcp_servers.", "");
    if (name === null) return { status: 0, stdout: `${Object.keys(servers).map((key) => `${key}:\n  x-aify-owner: aify-wrapper`).join("\n")}\n`, stderr: "" };
    const found = servers[name];
    if (!found) return { status: 1, stdout: "", stderr: `Config key not set: ${args[2]}` };
    return { status: 0, stdout: answer(found), stderr: "" };
  };
  const entries = [{ name: "aify-dashboard", value: ENTRY }];
  assert.deepEqual(planHermesEntries({ entries, run, markers: [] }), { ok: true, toWrite: entries, toRemove: ["gone"], kept: {} });
  assert.deepEqual(asked, ["config get mcp_servers", "config get mcp_servers.aify-dashboard"]);
  // The same answer, with a receipt for this value and this answer: kept, not written.
  const receipt = entryReceipt(ENTRY, answer(servers["aify-dashboard"]));
  assert.deepEqual(planHermesEntries({ entries, run, markers: [], receipts: { "aify-dashboard": receipt } }).kept, { "aify-dashboard": receipt });
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
  const budget = () => ({ deadlineMs: Date.now() + 60_000 });
  try {
    assert.deepEqual(configPlan(registry, budget()), { ok: true, current: false, detail: "" });
    assert.equal(fs.readFileSync(state, "utf8"), "{}", "the plan wrote");
    assert.deepEqual(configStep(registry, budget()), { ok: true, detail: "" });
    assert.deepEqual(JSON.parse(fs.readFileSync(state, "utf8"))["aify-dashboard"], ENTRY);
    assert.deepEqual(configPlan(registry, budget()), { ok: true, current: true, detail: "" });
    // A deadline already past starts no hermes call: the plan cannot answer, and says so.
    assert.equal(configPlan(registry, { deadlineMs: Date.now() - 1 }).ok, false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a step given a deadline already past calls no hermes at all, and says why", () => {
  // The applier's budget reaches every hermes call (lib/hermes-pending-config.mjs lockBudget), not only the step's process.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-deadline-"));
  try {
    const registry = path.join(dir, "services.json");
    fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { "aify-dashboard": DASHBOARD } }));
    fs.writeFileSync(path.join(dir, "state.json"), "{}");
    fs.mkdirSync(path.join(dir, "hermes", "installs", "another"), { recursive: true });
    const env = { ...process.env, HERMES_HOME: path.join(dir, "hermes"), HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, "local"),
      HERMES_RUNTIME_COMMAND: FAKE, FAKE_HERMES_STATE: path.join(dir, "state.json"), FAKE_HERMES_LOG: path.join(dir, "calls.log"), FAKE_HERMES_MODE: "" };
    for (const mode of ["--plan", "--write-now"]) {
      fs.writeFileSync(path.join(dir, "calls.log"), "");
      const run = spawnSync(process.execPath, [CLI, "--deadline", String(Date.now() - 1), mode, registry], { encoding: "utf8", env, timeout: 60_000 });
      assert.equal(run.status, 78, `${mode}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, /deadline passed before hermes was called/, mode);
      assert.equal(fs.readFileSync(path.join(dir, "calls.log"), "utf8"), "", `${mode} called hermes after its deadline`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("THE INSTALL STEP INTO A CONFIG ALREADY HOLDING ITS SERVERS writes nothing and records nothing, whatever runs here", () => {
  // aify-comms' installer runs this form too. Nothing is scanned: a config that is current needs no quiet host.
  const current = install({ cliMode: "", written: true });
  assert.equal(current.run.status, 0, current.run.stderr);
  assert.deepEqual(verbs(current.calls), ["get mcp_servers", "get mcp_servers.aify-dashboard"]);
  assert.match(current.run.stdout, /hermes config: the config already holds these servers\n/);
  assert.equal(current.pending, "none");
  const stale = install({ cliMode: "", written: true, recorded: true });
  assert.match(stale.run.stdout, /already holds these servers; the change recorded at .* is retired/);
  assert.equal(stale.pending, "none");
  assert.equal(install({ cliMode: "", written: true, recorded: "another.json" }).pending, "pending",
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

test("the receipts are kept per hermes config: one config's write leaves another's, and an unreadable file reads as none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hermes-receipts-"));
  try {
    const file = receiptsPath(dir);
    assert.equal(file, path.join(dir, ".aify", "hermes-config-receipts.json"));
    const store = new HermesConfigReceipts({ file });
    const [a, b] = [path.join(dir, "a", "config.yaml"), path.join(dir, "b", "config.yaml")];
    assert.deepEqual(store.read(a), {}, "no file is no receipt");
    store.write(a, { x: { value: "v", answer: "1" } });
    store.write(b, { y: { value: "v", answer: "2" } });
    assert.deepEqual(store.read(a), { x: { value: "v", answer: "1" } }, "another config's write replaced this one's");
    assert.deepEqual(store.read(path.join(dir, "c", "config.yaml")), {}, "a config never written has a receipt");
    const windows = new HermesConfigReceipts({ file, platform: "win32" });
    windows.write(a, { z: { value: "v", answer: "3" } });
    assert.deepEqual(windows.read(a.toUpperCase()), { z: { value: "v", answer: "3" } }, "on Windows a config is one file case-insensitively");
    fs.writeFileSync(file, "not json");
    assert.deepEqual(store.read(a), {}, "an unreadable file gave a receipt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
