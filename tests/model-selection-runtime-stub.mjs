// Executed only by model-selection-launch.test.js's sealed native-runtime replacement.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2), env = process.env;
const session = "11111111-2222-3333-4444-555555555555";
const transcript = path.join(env.HOME, ".claude", "projects", "p", `${session}.jsonl`);
const dir = path.join(env.HOME, ".aify", "sessions", "test-agent");
if (env.STUB_FRESH_MODEL === "1") fs.rmSync(path.join(env.HOME, ".claude", "projects"), { recursive: true });
fs.mkdirSync(dir, { recursive: true });
let settings;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--settings") settings = argv[++i];
  else if (argv[i].startsWith("--settings=")) settings = argv[i].slice(11);
}
const parsed = settings?.startsWith("{") ? JSON.parse(settings) : JSON.parse(fs.readFileSync(settings, "utf8"));
const ownIndex = argv.indexOf("--settings");
const own = JSON.parse(fs.readFileSync(argv[ownIndex + 1], "utf8"));
assert.equal(Object.hasOwn(own, "modelPicker"), false);
const fired = [];
function fire(event) {
  const commands = (parsed.hooks?.[event] || []).flatMap((group) => group.hooks || []).filter((hook) => hook.command.includes("aify-model-selection.mjs"));
  for (const hook of commands) {
    assert.notEqual(hook.async, true, `${event} scan must finish before the native process continues`);
    const payload = { hook_event_name: event, session_id: session, transcript_path: transcript, source: env.STUB_FRESH_MODEL === "1" ? "startup" : "resume" };
    const run = spawnSync(env.STUB_BASH, ["-c", hook.command], { env, encoding: "utf8", input: JSON.stringify(payload), timeout: 8000 });
    assert.equal(run.status, 0, `${event}: ${run.stderr}`); assert.equal(run.stdout, "", "model hooks must not inject context");
    fired.push(event);
  }
}
function append(display) {
  const command = { type: "user", version: "2.1.319", sessionId: session, uuid: randomUUID(), promptId: randomUUID(), timestamp: new Date().toISOString(),
    message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" } };
  const done = { ...command, uuid: randomUUID(), parentUuid: command.uuid, message: { role: "user", content: `<local-command-stdout>Set model to \`${display}\` and saved as your default for new sessions</local-command-stdout>` } };
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, JSON.stringify(command) + "\n" + JSON.stringify(done) + "\n");
}
fire("SessionStart");
for (const [display, event] of [["A", "PostModelSwitch"], ["B", "UserPromptSubmit"], ["A", "Stop"], ["A", "SessionEnd"]]) { append(display); fire(event); }
append("B"); // No following native hook: the waiting launcher's EXIT drain must deliver this one.
fs.writeFileSync(path.join(dir, "runtime-proof.json"), JSON.stringify({ fired, own, argv, marker: env.AIFY_MODEL_SELECTION, lifetime: env.AIFY_LIFETIME }));
process.exit(17);
