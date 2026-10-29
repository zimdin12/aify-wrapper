#!/usr/bin/env node
// The installer's hermes step: the servers opted into every session, written into the user's hermes config.
//
//   hermes-config-cli.mjs <registry path>               an install: written now into a quiet host, else recorded
//                                                         pending (lib/hermes-pending-config.mjs); nothing when current
//   hermes-config-cli.mjs --check <registry path>       only refuse what could not be written, starting no hermes
//   hermes-config-cli.mjs --plan <registry path>        whether anything would be written: exit 0 none, PLAN_CHANGES some
//   hermes-config-cli.mjs --write-now <registry path>   write what changed, hermes running or not: the pending
//                                                         change's step, run under its lock into a host found quiet
//
// ONE GATE FOR EVERY INSTALLER. aify-wrapper's install.sh and aify-comms' (scripts/hermes-session-servers.sh) both run
// the first form, so neither can write into a config a running hermes is watching (a reinstall, 2026-10-29, wrote the
// dashboard's entry with 24 hermes running). It exits 0 whether it wrote or left the change pending.
//
// Thin wiring over session-hermes.mjs (what to write) and hermes-config-install.mjs (how, through hermes' own
// commands): it supplies the file, the filesystem for the update check, and the hermes process. Exit 78 with the step
// named when anything refuses, so the installer says which hermes step failed instead of failing the whole client.
//
// The hermes command is HERMES_RUNTIME_COMMAND when set, as in hermes-aify, else `hermes`. A command ending in .mjs
// is run with this node, which is how a test stands a recording script in for hermes.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { credentialRead } from "./credential-file.mjs";
import { FileLockBusyError } from "./file-lock.mjs";
import { hostIsWsl, machineIdFor } from "./machine-id.mjs";
import { processTable } from "./process-identity.mjs";
import { parseRegistry } from "./registry.mjs";
import { hermesRoots, installHermesEntries, pendingUpdateMarkers, planHermesEntries, unexpandedHomeProblem } from "./hermes-config-install.mjs";
import { HermesConfigReceipts, receiptsPath } from "./hermes-config-receipts.mjs";
import { configPlan, configStep, hermesConfigTarget, PendingHermesConfig, pendingMarkerPath, PLAN_CHANGES } from "./hermes-pending-config.mjs";
import { sessionHermesEntries } from "./session-hermes.mjs";
import { hermesHttpEntries, sessionHttpServices, sessionKey } from "./session-http.mjs";

const EXIT_CONFIG = 78;
//: Per hermes call. A first run in a home can install tools, so this is generous; the step still ends.
const HERMES_CALL_TIMEOUT_MS = 300_000;
const MODES = ["--check", "--plan", "--write-now"];
// `--deadline <epoch ms>` first, from the pending change's applier: no hermes call starts after it, and none outlives
// it, so the step ends inside the lock it runs under (lib/hermes-pending-config.mjs `lockBudget`).
const given = process.argv.slice(2);
const deadlineMs = given[0] === "--deadline" ? Number(given[1]) : Infinity;
const args = given[0] === "--deadline" ? given.slice(2) : given;
const mode = MODES.includes(args[0]) ? args[0] : "install";
const file = args[mode === "install" ? 0 : 1];
const refuse = (lines) => {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(EXIT_CONFIG);
};
if (!file || Number.isNaN(deadlineMs)) refuse([`usage: hermes-config-cli.mjs [--deadline <epoch ms>] [${MODES.join(" | ")}] <registry path>`]);

let text = "";
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") refuse([`registry: cannot read ${file}: ${error.message}`]);
}
const parsed = parseRegistry(text);
if (!parsed.ok) refuse([`registry ${file} is not usable:`, ...parsed.errors.map((problem) => `  - ${problem}`)]);
const stdio = sessionHermesEntries(parsed.registry);
// The services reached over HTTP, with this machine's id and each one's key, found the one way (session-http.mjs).
const keys = {};
for (const service of sessionHttpServices(parsed.registry)) {
  const { key, refused } = await sessionKey(service, { url: service.endpoint, env: process.env, read: credentialRead });
  if (key) keys[service.name] = key;
  else process.stderr.write(`hermes config: ${service.name}: no key found (${refused}); its entry goes without one and the service decides\n`);
}
const http = hermesHttpEntries(parsed.registry, { machineId: machineIdFor({ platform: process.platform, hostname: hostname(), env: process.env, isWsl: hostIsWsl() }), keys });
const problems = [...(stdio.ok ? [] : stdio.problems), ...(http.ok ? [] : http.problems)];
if (problems.length) refuse([`registry ${file} cannot be given to hermes:`, ...problems.map((problem) => `  - ${problem}`)]);
const entries = { entries: [...stdio.entries, ...http.entries] };
if (mode === "--check") process.exit(0);

const unexpanded = unexpandedHomeProblem(process.env);
if (unexpanded !== null) refuse(["hermes config step failed at hermes update check:", `  ${unexpanded}`]);
const roots = hermesRoots({ env: process.env, platform: process.platform, homedir: homedir(), join, dirname, basename });
const markers = pendingUpdateMarkers(roots, {
  readdir: (dir) => {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  },
  exists: existsSync,
  join,
});

const command = process.env.HERMES_RUNTIME_COMMAND || "hermes";
const argv = command.endsWith(".mjs") ? [process.execPath, command] : [command];
const run = (words) => {
  const left = deadlineMs - Date.now();
  if (left <= 0) return { status: null, stdout: "", stderr: "this step's deadline passed before hermes was called" };
  const result = spawnSync(argv[0], [...argv.slice(1), ...words], { encoding: "utf8", input: "", timeout: Math.min(HERMES_CALL_TIMEOUT_MS, left) });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.error ? String(result.error.message) : result.stderr ?? "" };
};
// What this step last wrote into this config, as hermes read it back: the plan's evidence that an entry is current.
const target = hermesConfigTarget({ env: process.env, platform: process.platform, homedir: homedir() });
const receipts = new HermesConfigReceipts({ file: receiptsPath(homedir()) });

if (mode === "--plan") {
  const plan = planHermesEntries({ entries: entries.entries, run, markers, receipts: receipts.read(target) });
  if (!plan.ok) refuse([`hermes config step failed at ${plan.step}:`, `  ${plan.problem}`]);
  process.exit(plan.toWrite.length || plan.toRemove.length ? PLAN_CHANGES : 0);
}
if (mode === "install") {
  const pending = new PendingHermesConfig({ marker: pendingMarkerPath(homedir()) });
  let result;
  try {
    result = pending.install({ registry: file, target, scan: () => processTable({ commands: true }), step: configStep, plan: configPlan });
  } catch (error) {
    if (!(error instanceof FileLockBusyError)) throw error;
    refuse([`hermes config: a hermes start is applying an earlier change and still holds ${pending.lock.path}; re-run the installer when it is done`]);
  }
  process.stdout.write(`hermes config: ${result.detail}\n`);
  if (result.outcome === "deferred") {
    process.stdout.write("hermes config: the change is pending (aify-wrapper-check shows it); the first hermes start that finds no hermes running applies it\n");
  }
  process.exit(result.outcome === "failed" ? EXIT_CONFIG : 0);
}
const outcome = installHermesEntries({ entries: entries.entries, run, markers, receipts: receipts.read(target) });
if (!outcome.ok) refuse([`hermes config step failed at ${outcome.step}:`, `  ${outcome.problem}`]);
receipts.write(target, outcome.receipts);
process.stdout.write(`hermes config: wrote ${outcome.written.join(", ") || "nothing"}; removed ${outcome.removed.join(", ") || "nothing"}\n`);
// A RUNNING hermes reloads mcp_servers the moment their expanded content differs from what it loaded
// (hermes_cli/cli_info_mixin.py _check_config_mcp_changes); rewriting the same content reloads nobody.
if (outcome.written.length || outcome.removed.length) {
  process.stdout.write("hermes config: a running hermes agent reloads these servers if their content changed; install with hermes agents stopped\n");
}
