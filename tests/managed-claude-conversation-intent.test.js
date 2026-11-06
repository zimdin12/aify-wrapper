// Actual comms routes/SQLite -> actual argv/env producer -> rendered wrapper -> sealed native stub.
// The pin bridge alone is a contract stub; this does not qualify its future comms implementation or live delivery.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { KNOWN, launch } from "./launch-to-a-stub-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "managed-claude-caller-"));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));
let prepared;
before(() => {
  const repo = process.env.AIFY_COMMS_REPO;
  assert.ok(repo && fs.existsSync(path.join(repo, "service/tests/_base.py")), "mandatory actual comms producer fixture needs AIFY_COMMS_REPO");
  const env = { PATH: process.env.PATH, HOME: workspace, USERPROFILE: workspace, TMPDIR: workspace, TEMP: workspace, TMP: workspace,
    APPDATA: path.join(workspace, "AppData/Roaming"), LOCALAPPDATA: path.join(workspace, "AppData/Local"), PYTHONUTF8: "1",
    AIFY_ENV_REPO: process.env.AIFY_ENV_REPO, PYTHONDONTWRITEBYTECODE: "1",
    ...(process.env.AIFY_COMMS_TEST_PYTHON_USER_BASE ? { PYTHONUSERBASE: process.env.AIFY_COMMS_TEST_PYTHON_USER_BASE } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const inputs = [fileURLToPath(import.meta.url), path.join(ROOT, "tests/fixtures/managed-claude-launch.py"), ...[
    "service/tests/_base.py", "service/tests/defined_agents.py", "service/tests/published_state.py", "service/api_core/lifecycle_launch.py",
    "service/api_core/launch_env.py", "service/api_core/definition_creation.py", "service/api_core/handoff_restart.py", "service/runtimes/claude.py",
  ].map(file => path.join(repo, file))];
  const hashes = () => inputs.map(file => ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
  const beforeInputs = hashes();
  console.log("COMMS_PRODUCER_INPUTS", JSON.stringify({ files: beforeInputs, home: workspace, temp: workspace, python: process.env.AIFY_COMMS_TEST_PYTHON || "PATH:python", userBase: env.PYTHONUSERBASE || "" }));
  const result = spawnSync(process.env.AIFY_COMMS_TEST_PYTHON || "python", ["-B", path.join(ROOT, "tests/fixtures/managed-claude-launch.py"), repo, workspace, KNOWN], { env, cwd: workspace, encoding: "utf8", timeout: 60000 });
  assert.deepEqual(hashes(), beforeInputs, "named producer/fixture inputs changed during execution; this run is not qualified");
  assert.equal(result.status, 0, `actual private producer prerequisite/fixture failed, NOT_RUN (no handcrafted fallback): ${result.stderr}`);
  const receipt = JSON.parse(result.stdout);
  assert.equal(typeof receipt.interpreter, "string"); assert.equal(typeof receipt.fastapiVersion, "string");
  console.log("COMMS_PRODUCER_RUNTIME", JSON.stringify({ interpreter: receipt.interpreter, fastapiVersion: receipt.fastapiVersion }));
  prepared = receipt.launches;
  assert.deepEqual(prepared.map(row => row.mode), ["reset", "handoff", "new-definition", "resume"]);
});

const PIN = `import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'pin'})+'\\n');process.stdout.write('found\\t${KNOWN}\\n');\n`;
for (const mode of ["reset", "handoff", "new-definition", "resume"]) for (const staleMarker of [false, true]) test(`${mode}: real managed producer reaches native ${mode === "resume" ? "resume" : "fresh"}${staleMarker ? " despite a host's stale marker" : ""} without a pin query`, () => {
  const { launch: produced, entry } = prepared.find(row => row.mode === mode);
  assert.equal(produced.agentId, "coder"); assert.equal(produced.env.AIFY_MANAGED_VIA_WRAPPER, "1");
  assert.equal(produced.env.AIFY_SESSION_HANDLE, mode === "resume" ? KNOWN : "");
  const files = {};
  for (const file of ["bin/aify-claude-session.mjs", "lib/claude-sessions.mjs", ...(staleMarker ? ["bin/aify-lease.sh", "bin/aify-inherited-session.sh"] : [])]) files[`wrapper/${file}`] = fs.readFileSync(path.join(ROOT, file), "utf8");
  // Host-owned admission metadata comes from the real launch binding. Conversation fields/argv are unaltered.
  const env = { ...produced.env, AIFY_DEFINITION_INCARNATION: String(produced.definition.incarnation), AIFY_DEFINITION_REVISION: String(produced.definition.revision),
    ...(process.env.USERNAME ? { USERNAME: process.env.USERNAME } : {}), ...(process.env.USERDOMAIN ? { USERDOMAIN: process.env.USERDOMAIN } : {}),
    ...(staleMarker ? { CLAUDE_CODE_CHILD_SESSION: "1" } : {}) };
  const definition = { version: 1, agent: entry.definition, incarnation: entry.incarnation, revision: entry.revision, operation: randomUUID(), updatedAt: new Date().toISOString() };
  const result = launch("claude", produced.argv.slice(1), { env, definitions: { coder: definition }, files, bridgeFiles: { "session-for-agent.mjs": PIN } });
  assert.equal(result.run.status, 0, result.run.stderr); assert.equal(result.started.AIFY_AGENT_ID, "coder");
  const resume = result.args.indexOf("--resume"); assert.equal(resume < 0 ? "" : result.args[resume + 1], mode === "resume" ? KNOWN : "");
  assert.equal(result.started.CLAUDE_SESSION_ID || "", mode === "resume" ? KNOWN : "");
  assert.deepEqual(result.asked, [], "an automatic default consulted the stale pin instead of honoring real managed intent");
});
