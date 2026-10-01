#!/usr/bin/env node
// A launcher takes role, model and effort from its agent's definition, as defaults (P0 C9).
//
// EXECUTED THROUGH `--check`, on a rendered launcher, a sealed PATH and a stubbed runtime: `--check`
// reads the definition with the same function the launch does, reports what it resolved, and starts
// nothing. Precedence is flag > HARNESS_* > AIFY_* > definition > default; missing is today's
// behaviour; an invalid file, one for another harness, or a launcher that cannot run the reader refuses
// with 78 unless --aify-ignore-definition; a managed launch reads no file.
//
// THE BRIDGE DIRECTORY HOLDS ONLY THE READER (definition-reader-bridge.mjs); HOME is temporary too.
//
// `--check` resolves through the same function the launch does, after the same argument loop, so what
// it reports is what the launch would use (review of P6, R4). The launch itself, to a stub runtime and
// for an id a resume handle names, is executed in a-resumed-session-finds-its-agent-through-the-bridge.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { definitionsEnv, readerBridge } from "./definition-reader-bridge.mjs";
import { RUNTIME_COMMANDS, sealedPath, withPath } from "./sealed-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOWHERE = "http://127.0.0.2:1";
function setUp(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-definition-launcher-"));
  const bridge = readerBridge(path.join(dir, "bridge"));
  const out = path.join(dir, `${client}-aify`);
  execFileSync("bash", [path.join(ROOT, "render.sh"), `${client}-aify.sh.in`, out,
    `ENDPOINT=${NOWHERE}`, "REGISTRY_FINGERPRINT=test-fp", "SERVICE_NAME=aify-comms",
    `BRIDGE_DIR=${bridge.replace(/\\/g, "/")}`, "WRAPPER_VERSION=0.6.0", "SCRIPT_DIR=/nowhere", "NATIVE_BASE=/nowhere",
    "MCP_TRANSPORT=stdio", "STRICT_EXTRA_MCP_B64=", "SESSION_MCP_B64=", "HERMES_PLUGIN_PATH=/nowhere", "HERMES_STDIO_DIR=/nowhere",
    "HERMES_TUI_DIR=/nowhere"], { encoding: "utf8" });
  const defs = definitionsEnv(path.join(dir, "defs")).AIFY_AGENT_DEFINITIONS_DIR;
  fs.mkdirSync(path.join(dir, "home"));
  return { dir, out, defs, bridge, home: path.join(dir, "home") };
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

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()} ROLE PRECEDENCE: a flag in either spelling, then HARNESS_*, then AIFY_*, each beats the definition`, () => withLauncher(client, (setup) => {
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client })));
    const role = (options) => { const r = check(setup, options); assert.equal(r.status, 0, r.stderr); return line(r.stdout, "role"); };
    for (const flag of [["--aify-role", "flagged"], ["--aify-role=flagged"]]) {
      assert.equal(role({ args: ["--aify-agent", "lead", ...flag] }), "flagged", `${flag.join(" ")} against the definition`);
      assert.equal(role({ args: ["--aify-agent", "lead", ...flag], env: { HARNESS_ROLE: "harness" } }), "flagged", `${flag.join(" ")} against HARNESS_ROLE`);
    }
    assert.equal(role({ args: ["--aify-agent", "lead"], env: { HARNESS_ROLE: "harness", AIFY_AGENT_ROLE: "legacy" } }), "harness");
    assert.equal(role({ args: ["--aify-agent", "lead"], env: { AIFY_AGENT_ROLE: "legacy" } }), "legacy");
    assert.equal(role({ args: ["--aify-agent", "lead"] }), "reviewer", "the definition, when nothing above it says");
  }));
}

test("CLAUDE PRECEDENCE: the environment, then a flag, each beats the definition's model and effort", () => withLauncher("claude", (setup) => {
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition()));
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
  test(`${client.toUpperCase()}: --check takes the role from the definition`, () => withLauncher(client, (setup) => {
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client })));
    const found = check(setup, { args: ["--aify-agent", "lead"] });
    assert.equal(found.status, 0, found.stderr);
    assert.equal(line(found.stdout, "role"), "reviewer");
    assert.equal(line(found.stdout, "definition"), path.join(setup.defs, "lead.json"));
    assert.deepEqual([line(found.stdout, "model"), line(found.stdout, "effort")], ["opus", "high"], "the values the launch applies");
    const managed = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m", AIFY_MANAGED_EFFORT: "e" } });
    assert.deepEqual([line(managed.stdout, "model"), line(managed.stdout, "effort")], ["m", "e"]);
    const given = check(setup, { args: ["--aify-agent", "lead", client === "codex" ? "--model=x" : "-m", ...(client === "codex" ? [] : ["x"])] });
    assert.match(line(given.stdout, "model"), /^<given as an argument/);
    assert.equal(line(given.stdout, "effort"), "high");
  }));
}

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()}: A LAUNCHER THAT CANNOT RUN THE READER refuses with 78; ignoring the definition, or a managed launch, starts`, () => withLauncher(client, (setup) => {
    // Not being able to look is not finding nothing (review of P6, R2): with no file at all, the launch
    // still refuses, because without the reader it cannot know there is none.
    fs.rmSync(setup.bridge, { recursive: true, force: true });
    const refused = check(setup, { args: ["--aify-agent", "lead"] });
    assert.equal(refused.status, 78, `${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /no definition reader at .*, so the definition of 'lead' cannot be checked/);
    assert.match(refused.stderr, /--aify-ignore-definition/);
    const ignored = check(setup, { args: ["--aify-agent", "lead", "--aify-ignore-definition"] });
    assert.equal(ignored.status, 0, ignored.stderr);
    const managed = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_VIA_WRAPPER: "1" } });
    assert.equal(managed.status, 0, managed.stderr);
    const anonymous = check(setup);
    assert.equal(anonymous.status, 0, `no id, nothing to read: ${anonymous.stderr}`);
  }));
}

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()}: --aify-ignore-definition is consumed by the argument loop, never handed to the runtime`, () => {
    // Structural, and said so: the runtime's argv is not observable under --check.
    const text = fs.readFileSync(path.join(ROOT, "wrappers", `${client}-aify.sh.in`), "utf8");
    const loop = text.slice(text.indexOf('for ARG in "$@"; do', text.indexOf("aify_read_definition() {")));
    assert.match(loop, /if \[ "\$ARG" = "--aify-ignore-definition" \]; then\s+continue\s+fi/);
  });
}
