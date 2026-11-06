// Real parser/catalog/cursor -> exact POST capture. Env's own suite owns definition CAS/native-offset admission.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelSelectionReporter, explicitLaunchModel } from "../lib/model-selection-reporter.mjs";

const SESSION = "11111111-2222-3333-4444-555555555555";
function append(file, display = "A") {
  const command = { type: "user", version: "2.1.319", sessionId: SESSION, uuid: randomUUID(), promptId: randomUUID(), timestamp: "2026-11-06T18:00:00.000Z",
    message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" } };
  const done = { ...command, uuid: randomUUID(), parentUuid: command.uuid,
    message: { role: "user", content: `<local-command-stdout>Set model to \`${display}\` and saved as your default for new sessions</local-command-stdout>` } };
  fs.appendFileSync(file, JSON.stringify(command) + "\n" + JSON.stringify(done) + "\n");
}
async function world(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-model-report-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".claude"), project = path.join(root, "projects", "project"); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ modelPicker: { replaceBuiltInOptions: true, options: [{ model: "provider/a", label: "A" }, { model: "provider/b", label: "B" }] } }));
  const own = path.join(home, "hooks.json"); fs.writeFileSync(own, JSON.stringify({ hooks: {} }));
  const file = path.join(project, `${SESSION}.jsonl`); fs.writeFileSync(file, "");
  const lifetime = randomUUID(); const env = { HOME: home, USERPROFILE: home, AIFY_AGENT_ID: "test-agent", AIFY_LIFETIME: lifetime, AIFY_ENV_INSTANCE: "test-instance", AIFY_AGENT_LEASE: String(process.pid) };
  const descriptors = path.join(home, ".aify", "env"); fs.mkdirSync(descriptors, { recursive: true });
  fs.writeFileSync(path.join(descriptors, "test-instance.json"), JSON.stringify({ instance: "test-instance", pid: process.pid, startedAt: new Date().toISOString(), url: "http://127.0.0.1:45678" }));
  const posted = [], logs = []; let owned = true;
  const fetchImpl = async (url, options) => { posted.push({ url: String(url), options, body: JSON.parse(options.body) }); return { ok: true }; };
  const reporter = new ModelSelectionReporter({ env, home, owns: () => owned, managed: null, fetchImpl, log: (line) => logs.push(line),
    folder: async () => { const dir = path.join(home, ".aify", "sessions", "test-agent"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return { ok: true, dir }; }, ...extra });
  return { home, env, file, own, reporter, posted, logs, lose: () => { owned = false; }, payload: (event = "Stop", more = {}) => ({ hook_event_name: event, session_id: SESSION, transcript_path: file, source: "startup", ...more }) };
}

// The launch report sees only the original argv, and must not turn a missing option value into a model.
test("original explicit model argument extraction keeps the last supplied value and rejects missing option values", async (t) => {
  for (const [name, argv, expected] of [
    ["none", [], null], ["spaced", ["--model", "provider/a"], "provider/a"], ["equals", ["--model=provider/b"], "provider/b"],
    ["last", ["--model", "a", "--model=b"], "b"], ["missing", ["--model"], null],
    ["long flag", ["--model", "--safe"], null], ["short flag", ["--model", "-h"], null],
  ]) await t.test(name, () => assert.equal(explicitLaunchModel(argv), expected));
});

test("init captures launch and resumed fence; repeated completion sends exact agreed body", async (t) => {
  const w = await world(t); append(w.file, "B");
  const init = await w.reporter.initialize({ claimedAgent: "test-agent", resumeId: SESSION, ownSettings: w.own, argv: ["--model", "provider/a"] });
  assert.equal(init.ready, true); assert.equal(w.posted.length, 1);
  assert.deepEqual(w.posted[0].body, { instance: "test-instance", lifetime: w.env.AIFY_LIFETIME, harness: "claude", source: "launch", session: "", transcriptIdentity: null, endOffset: null, recordUuid: null, value: "provider/a" });
  await w.reporter.hook(w.payload("SessionStart")); assert.equal(w.posted.length, 1, "resumed history replayed");
  append(w.file); await w.reporter.hook(w.payload()); append(w.file); await w.reporter.hook(w.payload());
  assert.equal(w.posted.length, 3, "repeat A must not value-deduplicate");
  const bodies = w.posted.slice(1).map((r) => r.body);
  assert.equal(bodies[0].value, "provider/a"); assert.equal(bodies[1].value, "provider/a");
  assert.ok(bodies[1].endOffset > bodies[0].endOffset); assert.notEqual(bodies[1].recordUuid, bodies[0].recordUuid);
  assert.match(bodies[0].transcriptIdentity, /^[0-9a-f]{64}$/); assert.equal(bodies[0].session, SESSION);
  for (const p of w.posted) { assert.equal(p.options.redirect, "manual"); assert.equal(p.options.credentials, "omit"); assert.equal(p.url, "http://127.0.0.1:45678/agents/test-agent/model-selection"); assert.equal(Object.hasOwn(p.body, "firedAtUs"), false); }
});

// The native file can be created after fresh SessionStart; its absence is the zero-history witness.
test("fresh SessionStart binds an absent transcript at zero, then A and B are reported without a late EOF fence", async (t) => {
  const w = await world(t); fs.rmSync(path.dirname(path.dirname(w.file)), { recursive: true });
  await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] });
  await w.reporter.hook(w.payload("SessionStart"));
  fs.mkdirSync(path.dirname(w.file), { recursive: true }); append(w.file);
  await w.reporter.hook(w.payload()); append(w.file, "B"); await w.reporter.finish();
  assert.deepEqual(w.posted.slice(1).map((p) => p.body.value), ["provider/a", "provider/b"]);
  assert.ok(w.posted[2].body.endOffset > w.posted[1].body.endOffset);
});

test("fresh SessionStart with an existing file fences its history at the current length", async (t) => {
  const w = await world(t); append(w.file, "B");
  await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] }); await w.reporter.hook(w.payload("SessionStart"));
  await w.reporter.hook(w.payload()); assert.equal(w.posted.length, 1, "fresh existing history was replayed");
  append(w.file); await w.reporter.finish();
  assert.deepEqual(w.posted.map((p) => p.body.value), [null, "provider/a"]);
});

for (const argv of [["--resume", SESSION], ["-r", SESSION], ["--continue"], ["-c"], ["--session-id", SESSION]]) {
  test(`${argv[0]} with an absent transcript cannot acquire a zero fence`, async (t) => {
    const w = await world(t); fs.unlinkSync(w.file);
    await w.reporter.initialize({ claimedAgent: "test-agent", resumeId: argv[0] === "--resume" ? SESSION : "", ownSettings: w.own, argv });
    await w.reporter.hook(w.payload("SessionStart", { source: "resume" })); append(w.file); await w.reporter.finish();
    assert.equal(w.posted.length, 1, "resumed/seeded history was reported as a fresh choice");
  });
}

test("SessionEnd and normal-exit drain find choices with no further prompt; they never replay the same position", async (t) => {
  const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] });
  await w.reporter.hook(w.payload("SessionStart")); append(w.file);
  await w.reporter.hook(w.payload("SessionEnd")); assert.equal(w.posted.at(-1).body.value, "provider/a");
  const before = w.posted.length; await w.reporter.finish(); assert.equal(w.posted.length, before);
  append(w.file, "B"); await w.reporter.finish(); assert.equal(w.posted.at(-1).body.value, "provider/b");
});

test("unresolved advances a later no-write position; explicit Default is not launch null", async (t) => {
  const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] });
  assert.equal(w.posted[0].body.value, null); await w.reporter.hook(w.payload("SessionStart"));
  append(w.file, "unknown"); await w.reporter.hook(w.payload()); const unresolved = w.posted.at(-1).body;
  assert.equal(unresolved.value, null); assert.ok(unresolved.endOffset > 0);
  append(w.file, "A (default)"); await w.reporter.hook(w.payload());
  assert.equal(w.posted.at(-1).body.value, ""); assert.ok(w.posted.at(-1).body.endOffset > unresolved.endOffset);
});

for (const argv of [["--settings", "operator.json"], ["--settings={}"], ["--fork-session"]]) {
  test(`${argv[0]} disables command reports visibly but retains explicit launch report`, async (t) => {
    const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [...argv, "--model=provider/a"] });
    await w.reporter.hook(w.payload("SessionStart")); append(w.file); await w.reporter.hook(w.payload("SessionEnd")); await w.reporter.finish();
    assert.equal(w.posted.length, 1); assert.equal(w.posted[0].body.value, "provider/a"); assert.equal(w.logs.length, 1); assert.match(w.logs[0], /disabled/);
  });
}

test("lost ownership cannot overwrite current cursor or publish a report", async (t) => {
  const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] }); await w.reporter.hook(w.payload("SessionStart"));
  append(w.file); const file = path.join(w.home, ".aify", "sessions", "test-agent", "model-selection.json"), before = fs.readFileSync(file);
  w.lose(); await w.reporter.hook(w.payload()); assert.deepEqual(fs.readFileSync(file), before); assert.equal(w.posted.length, 1);
});

// State from the new lifetime is independently supplied; keeping the old lease PID must not let old hooks write it.
test("a foreign lifetime's persisted cursor is not overwritten by an old hook or EXIT drain", async (t) => {
  const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] }); await w.reporter.hook(w.payload("SessionStart"));
  const file = path.join(w.home, ".aify", "sessions", "test-agent", "model-selection.json");
  const state = JSON.parse(fs.readFileSync(file)); state.lifetime = randomUUID(); fs.writeFileSync(file, JSON.stringify(state));
  const before = fs.readFileSync(file); append(w.file);
  await w.reporter.hook(w.payload()); await w.reporter.finish();
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(w.posted.length, 1, "old lifetime sent a current completion");
});

test("a failed POST consumes its position, logs once and never queues or replays it", async (t) => {
  const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] }); await w.reporter.hook(w.payload("SessionStart"));
  let attempts = 0; w.reporter.fetchImpl = async () => { attempts++; throw new Error("fixture transport failure"); };
  append(w.file); await w.reporter.hook(w.payload()); await w.reporter.finish();
  assert.equal(attempts, 1); assert.equal(w.logs.length, 1); assert.match(w.logs[0], /failed; not queued or replayed/);
});

test("a later native-session switch is blocked rather than rebound or scanned as a new lifetime", async (t) => {
  const w = await world(t); await w.reporter.initialize({ claimedAgent: "test-agent", ownSettings: w.own, argv: [] }); await w.reporter.hook(w.payload("SessionStart"));
  const nextSession = randomUUID(), nextFile = path.join(path.dirname(w.file), `${nextSession}.jsonl`); fs.writeFileSync(nextFile, "{}\n");
  await w.reporter.hook(w.payload("SessionStart", { session_id: nextSession, transcript_path: nextFile, source: "resume" })); append(w.file);
  await w.reporter.hook(w.payload()); assert.equal(w.posted.length, 1);
});

test("no claimed identity means no state creation or POST", async (t) => {
  const w = await world(t); const init = await w.reporter.initialize({ claimedAgent: "another-agent", ownSettings: w.own, argv: [] });
  assert.equal(init.ready, false); assert.equal(w.posted.length, 0); assert.equal(fs.existsSync(path.join(w.home, ".aify", "sessions")), false);
});
