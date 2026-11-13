// This catches missing hook registration / EXIT wiring: the sealed runtime fires the generated effective settings,
// not a test-invented reporter call. Existing module tests do not prove the launcher reaches that producer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { KNOWN, launch } from "./launch-to-a-stub-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASH = process.platform === "win32" ? execFileSync("bash", ["-lc", 'cygpath -w "$(command -v bash)"'], { encoding: "utf8" }).trim() : execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const catalog = { modelPicker: { replaceBuiltInOptions: true, options: [{ model: "provider/a", label: "A" }, { model: "provider/b", label: "B" }] } };
const sourceFiles = {};
for (const dir of ["bin", "lib"]) for (const name of fs.readdirSync(path.join(ROOT, dir))) {
  if (!/\.(?:mjs|sh)$/.test(name)) continue;
  sourceFiles[`wrapper/${dir}/${name}`] = fs.readFileSync(path.join(ROOT, dir, name), "utf8");
}
const PRELOAD = `import fs from 'node:fs'; import path from 'node:path';
globalThis.fetch = async (url, options) => {
  if (!String(url).endsWith('/agents/test-agent/model-selection')) throw new Error('fixture forbids external requests');
  const dir = path.join(process.env.USERPROFILE || process.env.HOME, '.aify/sessions/test-agent');
  fs.appendFileSync(path.join(dir, 'posts.jsonl'), options.body + '\\n');
  return {ok:true};
};\n`;
function runCase(forwarded = false, extraEnv = {}, fresh = false) {
  return launch("claude", ["--aify-agent", "test-agent", "--managed", ...(fresh ? [] : ["--resume", KNOWN]), "--model", "provider/a", "--managed-settings", JSON.stringify(catalog), ...(forwarded ? ["--settings", "{\"hooks\":{}}"] : [])], {
    env: {
      AIFY_AGENT_ID: "test-agent", AIFY_SESSION_MODE: "managed", AIFY_ENV_INSTANCE: "test-instance", AIFY_ENV_URL: "http://127.0.0.1:45678", AIFY_LIFETIME: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      STUB_FRESH_MODEL: fresh ? "1" : "0", AIFY_MODEL_SELECTION: "stale-inherited-marker", STUB_BASH: BASH, ProgramFiles: ({ dir }) => path.join(dir, "program-files"),
      NODE_OPTIONS: ({ dir }) => `--import=${pathToFileURL(path.join(dir, "preload.mjs")).href}`,
      ...(process.env.USERNAME ? { USERNAME: process.env.USERNAME } : {}), ...(process.env.USERDOMAIN ? { USERDOMAIN: process.env.USERDOMAIN } : {}), ...extraEnv,
    },
    files: {
      ...sourceFiles,
      "preload.mjs": PRELOAD,
      "bridge/claude-channel.js": "// Channel presence fixture; the sealed runtime does not start MCP servers.\n",
      "stubs/reg.cmd": "@echo off\r\necho ERROR: The system was unable to find the specified registry key. 1>&2\r\nexit /b 1\r\n",
      "<home>/.claude.json": ({ bridge }) => JSON.stringify({ mcpServers: { "aify-comms-channel": { command: "node", args: [path.join(bridge, "claude-channel.js")] } } }),
      "stubs/model-runtime.mjs": fs.readFileSync(path.join(ROOT, "tests/model-selection-runtime-stub.mjs"), "utf8"),
      "stubs/claude": `#!/bin/bash\nexec node "$(dirname "$0")/model-runtime.mjs" "$@"\n`,
      "<home>/.aify/env/test-instance.json": JSON.stringify({ instance: "test-instance", pid: process.pid, startedAt: new Date().toISOString(), url: "http://127.0.0.1:45678" }),
    },
  });
}
function posts(result) { return (result.sessionFiles["test-agent/posts.jsonl"] || "").trim().split("\n").filter(Boolean).map(JSON.parse); }

// Independently exercise Stop's two producers: a duplicate JSON key could erase either model or Herdr hooks.
for (const [herdr, fresh] of [[false, false], [true, false], [false, true]]) test(`rendered ${herdr ? "Herdr/activity" : fresh ? "fresh" : "plain"} launcher registers all scan triggers and drains an unprompted last pick before releasing ownership`, () => {
  const result = runCase(false, herdr ? { AIFY_HERDR_PANE_FILE: ({ dir }) => path.join(dir, "fixture-pane.json"), AIFY_FILE_ACTIVITY: "1" } : {}, fresh);
  assert.equal(result.run.status, 17, result.run.stderr);
  const proof = JSON.parse(result.sessionFiles["test-agent/runtime-proof.json"]);
  assert.deepEqual(proof.fired, ["SessionStart", "PostModelSwitch", "UserPromptSubmit", "Stop", "SessionEnd"], "native effective settings lost a scan trigger");
  assert.equal(proof.marker, proof.lifetime, "only this initialized lifetime may run model hooks");
  assert.equal(Object.hasOwn(proof.own, "modelPicker"), false);
  const stop = proof.own.hooks.Stop.flatMap((group) => group.hooks);
  assert.equal(stop.filter((hook) => hook.command.includes("aify-model-selection.mjs")).length, 1);
  if (herdr) { assert.ok(stop.some((hook) => hook.command.includes("aify-herdr-state.sh") && hook.command.endsWith(" idle")), "model Stop erased Herdr's idle hook"); assert.ok(proof.own.hooks.PostToolUse, "activity hooks displaced"); }
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const commands = proof.own.hooks[event].flatMap((group) => group.hooks).map((hook) => hook.command);
    assert.ok(commands.some((cmd) => cmd.includes("claude-session-hook.js")), "session capture displaced");
    assert.ok(commands.some((cmd) => cmd.includes("aify-turn-start.mjs")), "turn-start displaced");
  }
  const sent = posts(result); assert.equal(sent.length, 6, "launch + five distinct native completions, including EXIT-only B");
  assert.equal(sent[0].source, "launch"); assert.equal(sent[0].value, "provider/a");
  assert.deepEqual(sent.slice(1).map((body) => body.value), ["provider/a", "provider/b", "provider/a", "provider/a", "provider/b"]);
  for (let i = 1; i < sent.length; i++) { assert.equal(sent[i].session, KNOWN); assert.equal(sent[i].source, "model-command"); if (i > 1) assert.ok(sent[i].endOffset > sent[i - 1].endOffset); }
});

test("forwarded native settings stay effective; one general warning and explicit launch report survive", () => {
  const result = runCase(true); assert.equal(result.run.status, 17, result.run.stderr);
  const proof = JSON.parse(result.sessionFiles["test-agent/runtime-proof.json"]);
  assert.deepEqual(proof.fired, [], "operator's effective empty hooks were overridden");
  const sent = posts(result); assert.equal(sent.length, 1); assert.equal(sent[0].source, "launch"); assert.equal(sent[0].value, "provider/a");
  assert.equal((result.run.stderr.match(/forwarded --settings may replace the wrapper's hooks/g) || []).length, 1, result.run.stderr);
  assert.doesNotMatch(result.run.stderr, /model-command reporting disabled|model-command values unresolved/, 'duplicate reporting-only warning');
});
