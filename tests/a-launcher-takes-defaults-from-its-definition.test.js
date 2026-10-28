#!/usr/bin/env node
// A launcher takes role, model and effort from its agent's definition, as defaults (P0 C9).
//
// EXECUTED THROUGH `--check`, on a rendered launcher, a sealed PATH and a stubbed runtime: `--check`
// reads the definition with the same function the launch does, reports what it resolved, and starts
// nothing. Precedence is flag > HARNESS_* > AIFY_* > definition > default; missing is today's
// behaviour; an invalid file, one for another harness, or a launcher that cannot run the reader refuses
// with 78 unless --aify-ignore-definition; a managed launch reads only the instructions (claude's once the lease has
// admitted it), and starts without them when it cannot.
//
// THE WRAPPER DIRECTORY HOLDS ONLY THE READER (definition-reader-wrapper.mjs); HOME is temporary too.
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

import { definitionsEnv, readerWrapper } from "./definition-reader-wrapper.mjs";
import { KNOWN, launch } from "./launch-to-a-stub-runtime.mjs";
import { ownerEnv } from "./private-credential.mjs";
import { RUNTIME_COMMANDS, sealedPath, withPath } from "./sealed-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOWHERE = "http://127.0.0.2:1";
function setUp(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-definition-launcher-"));
  const wrapper = readerWrapper(path.join(dir, "wrapper"));
  const out = path.join(dir, `${client}-aify`);
  execFileSync("bash", [path.join(ROOT, "render.sh"), `${client}-aify.sh.in`, out,
    `ENDPOINT=${NOWHERE}`, "REGISTRY_FINGERPRINT=test-fp", "SERVICE_NAME=aify-comms",
    "BRIDGE_DIR=/nowhere", `WRAPPER_DIR=${wrapper.replace(/\\/g, "/")}`, "WRAPPER_VERSION=0.6.0", "SCRIPT_DIR=/nowhere", "NATIVE_BASE=/nowhere",
    "MCP_TRANSPORT=stdio", "STRICT_EXTRA_MCP_B64=", "SESSION_MCP_B64=", "SESSION_HTTP_B64=", "SESSION_MCP_CODEX_B64=", "HERMES_PLUGIN_PATH=/nowhere", "HERMES_STDIO_DIR=/nowhere",
    "HERMES_TUI_DIR=/nowhere"], { encoding: "utf8" });
  const defs = definitionsEnv(path.join(dir, "defs")).AIFY_AGENT_DEFINITIONS_DIR;
  fs.mkdirSync(path.join(dir, "home"));
  return { dir, out, defs, wrapper, home: path.join(dir, "home") };
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

test("CLAUDE PRECEDENCE: the managed launch's values, then a flag, each beats the definition's model and effort", () => withLauncher("claude", (setup) => {
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition()));
  // No marker, so the definition IS read and the managed values must beat it; the identity is the one the
  // service writes beside them (without it they are a parent's, dropped: review of b7e60a7).
  const managedValues = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_MODEL: "m-env", AIFY_MANAGED_EFFORT: "e-env" } });
  assert.equal(line(managedValues.stdout, "definition"), path.join(setup.defs, "lead.json"), "control: the definition was read");
  assert.deepEqual([line(managedValues.stdout, "model"), line(managedValues.stdout, "effort")], ["m-env", "e-env"], "the managed launch beats the definition");
  const flagged = check(setup, { args: ["--aify-agent", "lead", "--model", "sonnet", "--effort=low"] });
  assert.deepEqual([line(flagged.stdout, "model"), line(flagged.stdout, "effort")], ["<given as an argument>", "<given as an argument>"]);
}));

test("CLAUDE: missing is today's behaviour; a managed launch reads no file", () => withLauncher("claude", (setup) => {
  const missing = check(setup, { args: ["--aify-agent", "lead"] });
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual([line(missing.stdout, "role"), line(missing.stdout, "definition"), line(missing.stdout, "model")],
    ["coder", "<none>", "<the runtime default>"]);
  fs.writeFileSync(path.join(setup.defs, "lead.json"), "{ not json");
  const managed = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-managed", AIFY_AGENT_ID: "lead" } });
  assert.equal(managed.status, 0, managed.stderr);
  assert.deepEqual([line(managed.stdout, "definition"), line(managed.stdout, "model")], ["<none>", "m-managed"]);
}));

// THE INSTRUCTIONS. A claude definition's `agent.instructions` reaches the runtime as a file in the agent's session
// folder, appended to its system prompt and rebuilt on a resume; a managed launch, which reads nothing else from the
// file, reads them. Executed to a stub runtime that records its argv.
const INSTRUCTIONS = "Answer in French.\n\"quoted\" $HOME `tick` \\ back\n";
const appended = (args) => {
  const at = args.indexOf("--append-system-prompt-file");
  return { file: at < 0 ? null : args[at + 1], snapshot: args[args.indexOf("--system-prompt-snapshot") + 1] };
};
const withInstructions = (id, instructions = INSTRUCTIONS) => ({ [id]: definition({ id, instructions }) });

test("CLAUDE: instructions reach the runtime as an appended prompt file, on a launch, a resume, and a managed launch", () => {
  const cases = [
    ["named", ["--aify-agent", "lead"], "lead", {}],
    ["resumed: read for the agent the handle names", ["--resume", KNOWN], "claude-code-recovered", {}],
    ["managed", ["--aify-agent", "lead"], "lead", { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" }],
  ];
  for (const [label, args, id, env] of cases) {
    const r = launch("claude", args, { definitions: withInstructions(id), env: { ...ownerEnv(), ...env } });
    assert.equal(r.run.status, 0, `${label}: ${r.run.stderr}`);
    const { file, snapshot } = appended(r.args);
    assert.ok(file, `${label}: no --append-system-prompt-file in ${r.args.join(" ")}`);
    assert.equal(snapshot, "off", `${label}: a resume would keep the prompt recorded when the conversation began`);
    assert.match(file.replace(/\\/g, "/"), new RegExp(`/\\.aify/sessions/${id}/instructions\\.txt$`), label);
    assert.equal(r.sessionFiles[`${id}/instructions.txt`], INSTRUCTIONS, `${label}: the file holds the text byte for byte`);
  }
});

test("CLAUDE: no instructions, no flag, and the file an earlier launch left is removed", () => {
  const left = { "<home>/.aify/sessions/lead/instructions.txt": "the old rules" };
  const r = launch("claude", ["--aify-agent", "lead"], { definitions: withInstructions("lead", ""), env: ownerEnv(), files: left });
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.deepEqual([appended(r.args).file, r.args.includes("--system-prompt-snapshot")], [null, false], r.args.join(" "));
  assert.equal(r.sessionFiles["lead/instructions.txt"], undefined, "the old rules were left for anything that finds the file");
});

test("CLAUDE: a managed launch that cannot read its definition, or has no reader, starts without instructions and says so", () => {
  const managed = { ...ownerEnv(), AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" };
  const unreadable = launch("claude", ["--aify-agent", "lead"], { definitions: { lead: "{ not json" }, env: managed });
  // The rendered launcher pointed at a definition helper that is not there; the wrapper's other helpers stay.
  const readerless = launch("claude", ["--aify-agent", "lead"], { definitions: withInstructions("lead"), env: managed,
    edit: (text) => text.replaceAll("bin/aify-definition.sh", "bin/no-such-helper.sh") });
  for (const [label, r, said] of [["unreadable", unreadable, /this managed launch starts WITHOUT its instructions/],
    ["no reader", readerless, /this managed launch starts WITHOUT any instructions/]]) {
    assert.equal(r.run.status, 0, `${label}: ${r.run.stderr}`);
    assert.equal(appended(r.args).file, null, label);
    assert.match(r.run.stderr, said, `${label}: the host decides, but the agent is told nothing: say so`);
  }
});

// THE FILE IS THE AGENT'S ONE, so only a start the lease admits may write it (the review of f177604 found mcp.json
// rewritten by a refused second launch). The lease here refuses as the real one does for an agent already running.
const REFUSING_LEASE = [
  'aify_lease_take_intent() { AIFY_LEASE_ARGS=("$@"); }',
  'aify_lease_claim() { echo "[lease] $1 is already running here" >&2; return 75; }',
  "aify_lease_attach() { :; }", "aify_lease_release() { :; }", "aify_lifetime_start() { :; }", "aify_lifetime_release() { :; }",
  "aify_lease_pid() { printf '%s' \"$1\"; }", "",
].join("\n");
test("CLAUDE: a second launch the lease refuses leaves the running agent's instructions file as it was", () => {
  const running = { "<home>/.aify/sessions/lead/instructions.txt": "the running session's rules" };
  for (const instructions of [INSTRUCTIONS, ""]) {
    const refused = launch("claude", ["--aify-agent", "lead"], { definitions: withInstructions("lead", instructions), env: ownerEnv(),
      files: { ...running, "wrapper/bin/aify-lease.sh": REFUSING_LEASE } });
    assert.equal(refused.run.status, 75, refused.run.stderr);
    assert.deepEqual(refused.args, [], "claude was started anyway");
    assert.equal(refused.sessionFiles["lead/instructions.txt"], "the running session's rules", `rewritten by a refused start (${JSON.stringify(instructions)})`);
  }
  // CONTROL: the lease alone decides. Refused, a launch with no file before it writes none; admitted, it writes one (a
  // folder the test made would fail custody, so the admitted start begins from none too).
  const fresh = (files) => launch("claude", ["--aify-agent", "lead"], { definitions: withInstructions("lead"), env: ownerEnv(), files });
  assert.deepEqual(fresh({ "wrapper/bin/aify-lease.sh": REFUSING_LEASE }).sessionFiles, {});
  const admitted = fresh({});
  assert.equal(admitted.sessionFiles["lead/instructions.txt"], INSTRUCTIONS, admitted.run.stderr);
});

test("CLAUDE: the instructions are written below the claim and the --shared handoff, the last steps before claude", () => {
  // Structural, and said so: a --shared launch execs aify-env, whose run of this launcher claims and writes.
  const text = fs.readFileSync(path.join(ROOT, "wrappers", "claude-aify.sh.in"), "utf8");
  const at = (needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const placed = at('\naify_place_instructions "${CLAUDE_AIFY_AGENT_ID:-}"');
  assert.ok(at("  aify_lease_claim ") < placed && at("  exec aify-env run ") < placed && placed < at("\nclaude "), "placed above the claim or the handoff");
});

test("CLAUDE: --check says whether the definition holds instructions, and writes none", () => withLauncher("claude", (setup) => {
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ instructions: INSTRUCTIONS })));
  const found = check(setup, { args: ["--aify-agent", "lead"] });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(line(found.stdout, "instructions"), "<the definition's, written once the lease admits the launch>");
  assert.equal(fs.existsSync(path.join(setup.home, ".aify", "sessions")), false, "--check wrote the agent's file");
  fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition()));
  assert.equal(line(check(setup, { args: ["--aify-agent", "lead"] }).stdout, "instructions"), "<none>");
}));

for (const client of ["codex", "hermes"]) {
  test(`${client.toUpperCase()}: a definition with instructions refuses with 78, managed or not, because the runtime cannot be handed them`, () => withLauncher(client, (setup) => {
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client, instructions: INSTRUCTIONS })));
    for (const [label, env] of [["unmanaged", {}], ["managed", { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" }]]) {
      const refused = check(setup, { args: ["--aify-agent", "lead"], env });
      assert.equal(refused.status, 78, `${label}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stderr, new RegExp(`agent\\.instructions: the ${client} launcher cannot hand them to the runtime`), label);
    }
  }));
}

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
    const managed = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m", AIFY_MANAGED_EFFORT: "e", AIFY_AGENT_ID: "lead" } });
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
    fs.rmSync(setup.wrapper, { recursive: true, force: true });
    const refused = check(setup, { args: ["--aify-agent", "lead"] });
    assert.equal(refused.status, 78, `${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /no definition reader at .*, so the definition of 'lead' cannot be checked/);
    assert.match(refused.stderr, /--aify-ignore-definition/);
    const ignored = check(setup, { args: ["--aify-agent", "lead", "--aify-ignore-definition"] });
    assert.equal(ignored.status, 0, ignored.stderr);
    const managed = check(setup, { args: ["--aify-agent", "lead"], env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" } });
    assert.equal(managed.status, 0, managed.stderr);
    assert.match(managed.stderr, /this managed launch starts WITHOUT any instructions/);
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

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()}: a launch inside another agent's managed session reads its own definition, not the parent's values`, () => withLauncher(client, (setup) => {
    // Every process a managed agent starts inherits AIFY_MANAGED_* beside the parent's AIFY_AGENT_ID, so a *-aify
    // started from inside that session skipped its own definition and ran the parent's model and effort (external
    // review of 0.8.4, a leftover from the 0.8.1 review).
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client })));
    const parent = { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-parent", AIFY_MANAGED_EFFORT: "e-parent" };
    const nested = check(setup, { args: ["--aify-agent", "lead"], env: { ...parent, AIFY_AGENT_ID: "parent-agent" } });
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(line(nested.stdout, "definition"), path.join(setup.defs, "lead.json"));
    assert.deepEqual([line(nested.stdout, "model"), line(nested.stdout, "effort")], ["opus", "high"]);
    const own = check(setup, { args: ["--aify-agent", "lead"], env: { ...parent, AIFY_AGENT_ID: "lead" } });
    assert.deepEqual([line(own.stdout, "definition"), line(own.stdout, "model"), line(own.stdout, "effort")],
      ["<none>", "m-parent", "e-parent"], "control: the launch the service addressed to this agent is still managed");
  }));
}

// THE MANAGED VALUES ARE KEPT ONLY FOR THE LAUNCH THE SERVICE ADDRESSED (review of b7e60a7): the id the launcher
// itself parsed equal to a non-empty inherited AIFY_AGENT_ID. Every other case drops every AIFY_MANAGED_* name by
// prefix; `--check`'s `managed` line names what was kept.
const managedOf = (stdout) => (line(stdout, "managed") || "").trim().split(/\s+/).filter((n) => n.startsWith("AIFY_MANAGED_")).sort();
for (const client of ["claude", "codex", "hermes"]) {
  test(`${client.toUpperCase()}: an empty, absent or other agent's identity, or no named agent, drops every managed value`, () => withLauncher(client, (setup) => {
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client })));
    const stray = { AIFY_MANAGED_MODEL: "m-stray", AIFY_MANAGED_EFFORT: "e-stray", AIFY_MANAGED_FOO: "x" };
    const cases = [
      ["identity empty", { ...stray, AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "" }, ["--aify-agent", "lead"]],
      ["identity absent", { ...stray, AIFY_MANAGED_VIA_WRAPPER: "1" }, ["--aify-agent", "lead"]],
      // Another agent's session whose marker is 0 or absent: the guard does not wait for the marker to be 1.
      ["another agent's, marker 0", { ...stray, AIFY_MANAGED_VIA_WRAPPER: "0", AIFY_AGENT_ID: "parent" }, ["--aify-agent", "lead"]],
      ["another agent's, marker absent", { ...stray, AIFY_AGENT_ID: "parent" }, ["--aify-agent", "lead"]],
    ];
    for (const [label, env, args] of cases) {
      const out = check(setup, { args, env });
      assert.equal(out.status, 0, `${label}: ${out.stderr}`);
      assert.deepEqual([line(out.stdout, "model"), line(out.stdout, "effort"), managedOf(out.stdout)], ["opus", "high", []], `${label}: ${out.stdout}`);
    }
    // THE MARKER DECIDES NOTHING HERE. The service writes AIFY_MANAGED_VIA_WRAPPER=0 on a codex or hermes console the
    // operator routes natively (launch_env.py) and still sends the agent's model; absent, it is the same launch.
    for (const [label, marker] of [["marker 0", { AIFY_MANAGED_VIA_WRAPPER: "0" }], ["marker absent", {}]]) {
      const out = check(setup, { args: ["--aify-agent", "lead"], env: { ...stray, ...marker, AIFY_AGENT_ID: "lead" } });
      assert.deepEqual([line(out.stdout, "model"), line(out.stdout, "effort")], ["m-stray", "e-stray"], `${label}: ${out.stdout}`);
    }
    // No agent named AND an empty identity: "" equals "", so only the non-empty check drops these.
    const anonymous = check(setup, { env: { ...stray, AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "" } });
    assert.deepEqual([line(anonymous.stdout, "model"), managedOf(anonymous.stdout)], ["<the runtime default>", []], anonymous.stdout);
    // CONTROL: with no agent named, the launcher's identity IS the inherited one (HARNESS_IDENTITY, then
    // AIFY_AGENT_ID), so this is the same agent and its managed values stay.
    const unnamed = check(setup, { env: { ...stray, AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" } });
    assert.deepEqual([line(unnamed.stdout, "identity"), line(unnamed.stdout, "model")], ["lead", "m-stray"], unnamed.stdout);
  }));

  test(`${client.toUpperCase()}: a repeated --aify-agent is judged as the launcher parses it (the last one), and the kept set is the whole prefix`, () => withLauncher(client, (setup) => {
    fs.writeFileSync(path.join(setup.defs, "lead.json"), JSON.stringify(definition({ harness: client })));
    const managed = { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-parent", AIFY_MANAGED_EFFORT: "e-parent", AIFY_MANAGED_FOO: "x", AIFY_AGENT_ID: "parent" };
    const toLead = check(setup, { args: ["--aify-agent", "parent", "--aify-agent", "lead"], env: managed });
    assert.deepEqual([line(toLead.stdout, "identity"), line(toLead.stdout, "model"), managedOf(toLead.stdout)], ["lead", "opus", []], toLead.stdout);
    const toParent = check(setup, { args: ["--aify-agent=lead", "--aify-agent", "parent"], env: managed });
    assert.deepEqual([line(toParent.stdout, "identity"), line(toParent.stdout, "model"), managedOf(toParent.stdout)],
      ["parent", "m-parent", ["AIFY_MANAGED_EFFORT", "AIFY_MANAGED_FOO", "AIFY_MANAGED_MODEL", "AIFY_MANAGED_VIA_WRAPPER"]],
      "control: the addressed launch keeps every managed name");
    // Where a pre-scan and the parse disagree: `--aify-agent` here is --aify-role's VALUE, so no agent is named
    // and the identity stays the inherited one. A scan for the flag read "lead" and dropped the values.
    const asRole = check(setup, { args: ["--aify-role", "--aify-agent", "lead"], env: managed });
    assert.deepEqual([line(asRole.stdout, "identity"), line(asRole.stdout, "model")], ["parent", "m-parent"], asRole.stdout);
  }));
}

// WHAT THE LAUNCH DOES WITH THE MARKER is read below the guard too: above it, a launcher started inside another
// agent's managed session took that agent's marker (review of the guard's first move). Executed to a stub runtime.
const nestedIn = (parent) => ({ AIFY_AGENT_ID: parent, AIFY_MANAGED_VIA_WRAPPER: "1", HERMES_SESSION_ID: "parent-sess" });
test("HERMES: a nested launch does not resume the session its parent's environment names", () => {
  const nested = launch("hermes", ["--aify-agent", "lead", "chat"], { env: nestedIn("parent") });
  assert.equal(nested.run.status, 0, nested.run.stderr);
  assert.equal(nested.started.HERMES_SESSION_ID, undefined, "the parent's conversation was resumed");
  const own = launch("hermes", ["--aify-agent", "lead", "chat"], { env: nestedIn("lead") });
  assert.equal(own.started.HERMES_SESSION_ID, "parent-sess", "control: the launch the service addressed resumes its session");
  // The command line's handle still beats the one the environment names, as it did above the guard.
  const given = launch("hermes", ["--aify-agent", "lead", "--resume", "own-sess", "chat"], { env: nestedIn("lead") });
  assert.equal(given.started.HERMES_SESSION_ID, "own-sess", "the inherited handle overrode the one the command line gave");
});

test("CODEX: a nested launch does not take its parent's --disable apps", () => {
  const disables = (r) => r.appServerArgs.join(" ").includes("--disable apps");
  const nested = launch("codex", ["--aify-agent", "lead"], { env: nestedIn("parent") });
  assert.equal(nested.run.status, 0, nested.run.stderr);
  assert.equal(disables(nested), false, nested.appServerArgs.join(" "));
  assert.equal(disables(launch("codex", ["--aify-agent", "lead"], { env: nestedIn("lead") })), true, "control: the addressed launch disables apps");
});

test("PI: the inherited identity is compared before the launcher exports its own, so a nested pi-aify drops the managed values", () => withLauncher("pi", (setup) => {
  const env = { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-parent", AIFY_MANAGED_FOO: "x", AIFY_AGENT_ID: "parent" };
  const nested = check(setup, { args: ["--aify-agent", "lead"], env });
  assert.equal(nested.status, 0, nested.stderr);
  assert.deepEqual([line(nested.stdout, "identity"), managedOf(nested.stdout)], ["lead", []], nested.stdout);
  const own = check(setup, { args: ["--aify-agent", "parent"], env });
  assert.deepEqual(managedOf(own.stdout), ["AIFY_MANAGED_FOO", "AIFY_MANAGED_MODEL", "AIFY_MANAGED_VIA_WRAPPER"], `control: ${own.stdout}`);
}));
