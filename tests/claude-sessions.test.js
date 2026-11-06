// One selected profile for resume validation/defaults/model capture; protocol is the agreed comms stub contract.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeConfigRoot, ClaudeTranscripts, parsePinReply, ClaudePinLookup, pinnedResumeEligible } from "../lib/claude-sessions.mjs";

const ID = "11111111-2222-3333-4444-555555555555";
function world(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-profile-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const intent = { explicit: true, selector: false, fresh: false, shared: false, resumeId: "", agentId: "test-agent", env: {} };
test("pinnedResumeEligible admits an ordinary named operator", () => assert.equal(pinnedResumeEligible(intent), true));
// Each independently supplied guard has its own result; one failure must not conceal the next input.
for (const [name, change] of Object.entries({ anonymous: { explicit: false }, selector: { selector: true }, fresh: { fresh: true },
  shared: { shared: true }, conversation: { resumeId: ID }, "missing identity": { agentId: "" },
  "missing selector fact": { selector: undefined }, "missing frame": { env: null }, "ambient generic handle": { env: { AIFY_SESSION_HANDLE: ID } },
})) test(`pinnedResumeEligible refuses ${name}`, () => {
  let result;
  assert.doesNotThrow(() => { result = pinnedResumeEligible({ ...intent, ...change }); }, "invalid intent must refuse without throwing");
  assert.equal(result, false);
});
test("pinnedResumeEligible uses the matched incoming managed frame, not handle presence or a foreign managed flag", () => {
  const env = { AIFY_AGENT_ID: "test-agent", AIFY_SESSION_MODE: "managed", AIFY_MANAGED_VIA_WRAPPER: "1" };
  assert.equal(pinnedResumeEligible({ ...intent, env }), false);
  assert.equal(pinnedResumeEligible({ ...intent, env: { ...env, AIFY_SESSION_HANDLE: "" } }), false);
  assert.equal(pinnedResumeEligible({ ...intent, env: { ...env, AIFY_AGENT_ID: "other-agent" } }), true);
});

test("claudeConfigRoot uses an explicit selected profile, otherwise the caller's native home; missing input refuses", () => {
  assert.equal(claudeConfigRoot({ env: { CLAUDE_CONFIG_DIR: "chosen" }, home: "native-home" }), "chosen");
  assert.equal(claudeConfigRoot({ env: {}, home: "native-home" }), path.join("native-home", ".claude"));
  assert.throws(() => claudeConfigRoot({ env: {} }), /home|profile/);
});
test("ClaudeTranscripts finds a regular file only inside the selected profile, with present/absent and traversal controls", (t) => {
  const home = world(t), selected = path.join(home, "selected"), fallback = path.join(home, ".claude/projects/p");
  fs.mkdirSync(fallback, { recursive: true }); fs.writeFileSync(path.join(fallback, `${ID}.jsonl`), "{}\n");
  const reader = new ClaudeTranscripts({ env: { CLAUDE_CONFIG_DIR: selected }, home });
  assert.equal(reader.find(ID), null, "borrowed another profile's file");
  const project = path.join(selected, "projects", "p"); fs.mkdirSync(project, { recursive: true }); const file = path.join(project, `${ID}.jsonl`); fs.writeFileSync(file, "{}\n");
  fs.writeFileSync(path.join(selected, "projects", "elsewhere.jsonl"), "{}\n");
  assert.equal(reader.find(ID), file); assert.equal(reader.find("../elsewhere"), null, "accepted an existing traversal target outside a project"); assert.equal(reader.find("not-present"), null);
  fs.unlinkSync(file); fs.mkdirSync(file); assert.equal(reader.find(ID), null, "a directory is not a transcript");
});
test("ClaudePinLookup executes only the service-owned program with a deadline, and requires a local regular transcript", async (t) => {
  const home = world(t), bridge = path.join(home, "bridge"), project = path.join(home, ".claude/projects/p");
  fs.mkdirSync(bridge); fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(bridge, "session-for-agent.mjs"), "// fixture\n");
  const file = path.join(project, `${ID}.jsonl`); fs.writeFileSync(file, "{}\n"); const calls = [];
  const lookup = new ClaudePinLookup({ home, env: {}, bridge, endpoint: "http://127.0.0.2:1", agentId: "test-agent", run: (executable, argv, options) => {
    calls.push({ executable, argv, options }); return { status: 0, stdout: `found\t${ID}\n` };
  } });
  assert.deepEqual(lookup.lookup(), { status: "found", session: ID });
  assert.equal(calls.length, 1); assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].argv, [path.join(bridge, "session-for-agent.mjs"), "http://127.0.0.2:1", "claude-code", "test-agent"]);
  assert.equal(calls[0].options.timeout, 3000); assert.equal(calls[0].options.maxBuffer, 4096); assert.equal(calls[0].options.shell, false);
  for (const [name, failed] of [["nonzero exit", { status: 70 }], ["transport error despite zero status", { status: 0, error: new Error("timeout") }]]) await t.test(name, () => {
    lookup.run = () => ({ ...failed, stdout: `found\t${ID}\n` });
    assert.deepEqual(lookup.lookup(), { status: "unavailable", session: "" }, "failed helper stdout cannot select a conversation");
  });
  lookup.run = () => ({ status: 0, stdout: `found\t${ID}\n` });
  fs.unlinkSync(file); assert.deepEqual(lookup.lookup(), { status: "missing-transcript", session: "" });
});

test("ClaudePinLookup never treats an empty bridge root as authority to execute a project helper", t => {
  const dir = world(t), home = path.join(dir, "home"), project = path.join(home, ".claude/projects/p");
  fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, `${ID}.jsonl`), "{}\n");
  const marker = path.join(dir, "called");
  fs.writeFileSync(path.join(dir, "session-for-agent.mjs"), `import fs from 'node:fs';fs.writeFileSync('called','1');process.stdout.write('found\\t${ID}\\n');`);
  const cli = fileURLToPath(new URL("../bin/aify-claude-session.mjs", import.meta.url));
  const run = bridge => spawnSync(process.execPath, [cli, "pin", bridge, "http://127.0.0.2:1", "test-agent"], {
    env: { HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, cwd: dir, encoding: "utf8", timeout: 10000,
  });
  const owned = run(dir); assert.equal(owned.status, 0, owned.stderr); assert.equal(owned.stdout, ID); assert.equal(fs.existsSync(marker), true);
  fs.unlinkSync(marker);
  const absent = run(""); assert.equal(absent.status, 0, absent.stderr);
  assert.equal(fs.existsSync(marker), false, "empty root executed a project helper"); assert.equal(absent.stdout, ""); assert.match(absent.stderr, /fresh/i);
});

// Unlike injected-home unit tests, these exercise the actual native CLI entry points with disagreeing homes.
for (const program of ["aify-claude-session.mjs", "aify-claude-default-model.mjs"]) test(`${program} uses its native platform home when shell HOME and USERPROFILE disagree`, t => {
  const dir = world(t), shell = path.join(dir, "shell"), profile = path.join(dir, "profile"), cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);
  for (const [home, model] of [[shell, "shell-model"], [profile, "profile-model"]]) {
    fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model }));
  }
  const native = process.platform === "win32" ? profile : shell, foreign = native === profile ? shell : profile;
  const transcript = path.join(native, ".claude", "projects", "p", `${ID}.jsonl`); fs.writeFileSync(transcript, "{}\n");
  const env = { HOME: shell, USERPROFILE: profile, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const cli = fileURLToPath(new URL(`../bin/${program}`, import.meta.url));
  const args = program === "aify-claude-session.mjs" ? ["exists", ID] : [cwd];
  const run = () => spawnSync(process.execPath, [cli, ...args], { env, cwd, encoding: "utf8", timeout: 10000 });
  const found = run(); assert.equal(found.status, 0, found.stderr);
  if (program === "aify-claude-default-model.mjs") assert.equal(found.stdout.trim(), native === profile ? "profile-model" : "shell-model");
  else {
    fs.unlinkSync(transcript); fs.writeFileSync(path.join(foreign, ".claude", "projects", "p", `${ID}.jsonl`), "{}\n");
    assert.equal(run().status, 1, "the other home's file must not attest a native transcript");
  }
});

for (const ending of ["", "\n", "\r\n"]) test(`parsePinReply accepts exactly the controlled found line with ending ${JSON.stringify(ending)}`, () => {
  assert.deepEqual(parsePinReply(`found\t${ID}${ending}`), { status: "found", session: ID });
});
for (const status of ["none", "wrong-runtime", "unavailable"]) test(`parsePinReply preserves the declared ${status} refusal`, () => {
  assert.deepEqual(parsePinReply(`${status}\n`), { status, session: "" });
});
for (const reply of ["found\tbad", `found ${ID}`, `found\t${ID}\nextra`, `found\t${ID}\n\n`, `none\t${ID}`, "garbage", "", `found\t${ID}\u0000`]) test(`parsePinReply rejects malformed ${JSON.stringify(reply)} without guessing`, () => {
  assert.deepEqual(parsePinReply(reply), { status: "unavailable", session: "" });
});
