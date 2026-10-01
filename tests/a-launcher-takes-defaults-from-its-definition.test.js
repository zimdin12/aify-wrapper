#!/usr/bin/env node
// A launcher takes role, model and effort from its agent's definition, as defaults (P0 C9).
//
// EXECUTED THROUGH `--check`, on a rendered launcher, a sealed PATH and a stubbed runtime: `--check`
// reads the definition with the same function the launch does, reports what it resolved, and starts
// nothing. Precedence is flag > HARNESS_* > AIFY_* > definition > default; missing is today's
// behaviour; an invalid file, or one for another harness, refuses with 78 unless
// --aify-ignore-definition; a managed launch reads no file.
//
// THE BRIDGE DIRECTORY HOLDS ONLY THE READER. A whole aify-wrapper there would let the launcher find
// and run its lease script, which writes under the real home; HOME is a temporary directory as well.
//
// WHAT IS NOT EXECUTED: codex and hermes are judged through `--check` and their rendered text. Their
// launch path cannot run here without starting an app-server or a gateway host, so the lines that
// apply the definition after the argument loop are pinned structurally, and say so.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { RUNTIME_COMMANDS, sealedPath, withPath } from "./sealed-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOWHERE = "http://127.0.0.2:1";
const READER = ["bin/aify-definition.mjs", "lib/agent-definition-defaults.mjs", "lib/agent-definition-schema.mjs", "lib/main-module.mjs"];

function setUp(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-definition-launcher-"));
  const bridge = path.join(dir, "bridge");
  for (const file of READER) {
    const to = path.join(bridge, "node_modules", "aify-wrapper", file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), to);
  }
  const out = path.join(dir, `${client}-aify`);
  execFileSync("bash", [path.join(ROOT, "render.sh"), `${client}-aify.sh.in`, out,
    `ENDPOINT=${NOWHERE}`, "REGISTRY_FINGERPRINT=test-fp", "SERVICE_NAME=aify-comms",
    `BRIDGE_DIR=${bridge.replace(/\\/g, "/")}`, "WRAPPER_VERSION=0.6.0", "SCRIPT_DIR=/nowhere", "NATIVE_BASE=/nowhere",
    "MCP_TRANSPORT=stdio", "STRICT_EXTRA_MCP_B64=", "HERMES_PLUGIN_PATH=/nowhere", "HERMES_STDIO_DIR=/nowhere",
    "HERMES_TUI_DIR=/nowhere"], { encoding: "utf8" });
  const defs = path.join(dir, "defs");
  fs.mkdirSync(defs);
  fs.mkdirSync(path.join(dir, "home"));
  return { dir, out, defs, home: path.join(dir, "home") };
}

const definition = (over = {}) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "claude",
  mode: "resident", workspace: "C:/work", model: "opus", effort: "high", instructions: "", env: {}, herdrSpace: true, ...over } });

/** The ambient agent variables of the shell running this suite would decide the answers: none pass. */
function sealedEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(AIFY_|HARNESS_|CLAUDE_|CODEX_|HERMES_)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

function check(setup, { args = [], env = {} } = {}) {
  const sealed = sealedPath(RUNTIME_COMMANDS);
  const result = spawnSync("bash", [setup.out, "--check", ...args], {
    encoding: "utf8",
    env: withPath(sealedEnv({ AIFY_COMMS_URL: NOWHERE, AIFY_AGENT_DEFINITIONS_DIR: setup.defs,
      HOME: setup.home, USERPROFILE: setup.home, ...env }), sealed.PATH),
  });
  fs.rmSync(sealed.dir, { recursive: true, force: true });
  return result;
}

const line = (stdout, label) => (new RegExp(`^  ${label}\\s*: (.*)$`, "m").exec(stdout) || [])[1];

function withLauncher(client, body) {
  const setup = setUp(client);
  try { body(setup); } finally { fs.rmSync(setup.dir, { recursive: true, force: true }); }
}

test("CLAUDE: the definition supplies role, model and effort when nothing above it does", () => withLauncher("claude", (setup) => {
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition()));
  const found = check(setup, { args: ["--aify-agent", "lead"] });
  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual([line(found.stdout, "role"), line(found.stdout, "model"), line(found.stdout, "effort")], ["reviewer", "opus", "high"], found.stdout);
  assert.equal(line(found.stdout, "definition"), path.join(setup.defs, "lead.json"));
}));

test("CLAUDE PRECEDENCE: a flag, then HARNESS_*, then AIFY_*, each beats the definition", () => withLauncher("claude", (setup) => {
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition()));
  const role = (result) => line(result.stdout, "role");
  assert.equal(role(check(setup, { args: ["--aify-agent", "lead", "--aify-role", "flagged"], env: { HARNESS_ROLE: "harness" } })), "flagged");
  assert.equal(role(check(setup, { args: ["--aify-agent", "lead"], env: { HARNESS_ROLE: "harness", AIFY_AGENT_ROLE: "legacy" } })), "harness");
  assert.equal(role(check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_AGENT_ROLE: "legacy" } })), "legacy");
  const managedValues = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_MODEL: "m-env", AIFY_MANAGED_EFFORT: "e-env" } });
  assert.deepEqual([line(managedValues.stdout, "model"), line(managedValues.stdout, "effort")], ["m-env", "e-env"], "the environment beats the definition");
  const flagged = check(setup, { args: ["--aify-agent", "lead", "--model", "sonnet", "--effort=low"] });
  assert.deepEqual([line(flagged.stdout, "model"), line(flagged.stdout, "effort")], ["<given as an argument>", "<given as an argument>"]);
}));

test("CLAUDE: missing is today's behaviour; a managed launch reads no file", () => withLauncher("claude", (setup) => {
  const missing = check(setup, { args: ["--aify-agent", "lead"] });
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual([line(missing.stdout, "role"), line(missing.stdout, "definition"), line(missing.stdout, "model")],
    ["coder", "<none>", "<the runtime default>"]);
  fs.writeFileSync(path.join(setup.defs, "lead.json"), "{ not json");
  const managed = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-managed" } });
  assert.equal(managed.status, 0, managed.stderr);
  assert.deepEqual([line(managed.stdout, "definition"), line(managed.stdout, "model")], ["<none>", "m-managed"]);
}));

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()}: an invalid file or another harness's refuses with 78, and --aify-ignore-definition starts without it`, () => withLauncher(client, (setup) => {
    const file = path.join(setup.defs, "lead.json");
    fs.writeFileSync(file, "{ not json");
    const invalid = check(setup, { args: ["--aify-agent", "lead"] });
    assert.equal(invalid.status, 78, `${invalid.stdout}${invalid.stderr}`);
    assert.match(invalid.stderr, /file: not-json/);
    assert.match(invalid.stderr, /--aify-ignore-definition/);
    fs.writeFileSync(file, JSON.stringify(definition({ harness: client === "hermes" ? "codex" : "hermes" })));
    const mismatch = check(setup, { args: ["--aify-agent", "lead"] });
    assert.equal(mismatch.status, 78, `${mismatch.stdout}${mismatch.stderr}`);
    assert.match(mismatch.stderr, new RegExp(`this is the ${client} launcher`));
    const ignored = check(setup, { args: ["--aify-agent", "lead", "--aify-ignore-definition"] });
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.equal(line(ignored.stdout, "definition"), "<none>");
  }));
}

for (const client of ["codex", "hermes"]) {
  test(`${client.toUpperCase()}: --check takes the role from the definition, and the launch path applies it after the loop`, () => withLauncher(client, (setup) => {
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client })));
    const found = check(setup, { args: ["--aify-agent", "lead"] });
    assert.equal(found.status, 0, found.stderr);
    assert.equal(line(found.stdout, "role"), "reviewer");
    assert.equal(line(found.stdout, "definition"), path.join(setup.defs, "lead.json"));
    const text = fs.readFileSync(setup.out, "utf8");
    const prefix = client.toUpperCase();
    const read = text.indexOf(`aify_read_definition "$${prefix}_AIFY_AGENT_ID"`);
    const applied = text.indexOf(`${prefix}_AIFY_ROLE="\${${prefix}_AIFY_ROLE:-\${AIFY_DEF_ROLE:-coder}}"`);
    const exported = text.indexOf(`export AIFY_AGENT_ROLE="$${prefix}_AIFY_ROLE"`);
    assert.ok(read > 0 && applied > read && exported > applied, `read ${read}, applied ${applied}, exported ${exported}: out of order or missing`);
    assert.match(text, /the definition's model and effort are not applied by this launcher/);
  }));
}

test("AN INSTALL WITHOUT THE READER launches as before, and says the definition is not applied", () => withLauncher("claude", (setup) => {
  fs.rmSync(path.join(path.dirname(setup.out), "bridge"), { recursive: true, force: true });
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition()));
  const result = check(setup, { args: ["--aify-agent", "lead"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no definition reader at .*, so any definition of 'lead' is not applied/);
  assert.deepEqual([line(result.stdout, "definition"), line(result.stdout, "role")], ["<none>", "coder"]);
}));

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()}: --aify-ignore-definition is consumed by the argument loop, never handed to the runtime`, () => {
    // Structural, and said so: the runtime's argv is not observable under --check.
    const text = fs.readFileSync(path.join(ROOT, "wrappers", `${client}-aify.sh.in`), "utf8");
    const loop = text.slice(text.indexOf('for ARG in "$@"; do', text.indexOf("aify_read_definition() {")));
    assert.match(loop, /if \[ "\$ARG" = "--aify-ignore-definition" \]; then\s+continue\s+fi/);
  });
}
