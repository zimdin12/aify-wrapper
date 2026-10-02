#!/usr/bin/env node
// The installer's hermes step: the servers opted into every session, written into the user's hermes config.
//
//   hermes-config-cli.mjs <registry path>           write the entries
//   hermes-config-cli.mjs --check <registry path>   only refuse what could not be written, starting no hermes
//
// Thin wiring over session-hermes.mjs (what to write) and hermes-config-install.mjs (how, through hermes' own
// commands): it supplies the file, the filesystem for the update check, and the hermes process. Exit 78 with the step
// named when anything refuses, so the installer says which hermes step failed instead of failing the whole client.
//
// The hermes command is HERMES_RUNTIME_COMMAND when set, as in hermes-aify, else `hermes`. A command ending in .mjs
// is run with this node, which is how a test stands a recording script in for hermes.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { parseRegistry } from "./registry.mjs";
import { hermesRoots, installHermesEntries, pendingUpdateMarkers, unexpandedHomeProblem } from "./hermes-config-install.mjs";
import { sessionHermesEntries } from "./session-hermes.mjs";

const EXIT_CONFIG = 78;
//: Per hermes call. A first run in a home can install tools, so this is generous; the step still ends.
const HERMES_CALL_TIMEOUT_MS = 300_000;
const checkOnly = process.argv[2] === "--check";
const file = process.argv[checkOnly ? 3 : 2];
const refuse = (lines) => {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(EXIT_CONFIG);
};
if (!file) refuse(["usage: hermes-config-cli.mjs [--check] <registry path>"]);

let text = "";
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") refuse([`registry: cannot read ${file}: ${error.message}`]);
}
const parsed = parseRegistry(text);
if (!parsed.ok) refuse([`registry ${file} is not usable:`, ...parsed.errors.map((problem) => `  - ${problem}`)]);
const entries = sessionHermesEntries(parsed.registry);
if (!entries.ok) refuse([`registry ${file} cannot be given to hermes:`, ...entries.problems.map((problem) => `  - ${problem}`)]);
if (checkOnly) process.exit(0);

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
const run = (args) => {
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], { encoding: "utf8", input: "", timeout: HERMES_CALL_TIMEOUT_MS });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.error ? String(result.error.message) : result.stderr ?? "" };
};

const outcome = installHermesEntries({ entries: entries.entries, run, markers });
if (!outcome.ok) refuse([`hermes config step failed at ${outcome.step}:`, `  ${outcome.problem}`]);
process.stdout.write(`hermes config: wrote ${outcome.written.join(", ") || "nothing"}; removed ${outcome.removed.join(", ") || "nothing"}\n`);
