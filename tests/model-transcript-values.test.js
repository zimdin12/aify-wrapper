// The completion, not the next request or a switch hook, is the explicit-choice witness.
// Covers the new picker/system shapes and catalog rules; the retained model-selection.test.js covers old typed pairing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { confirmedModelCommands } from "../lib/model-selection.mjs";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CATALOG = { rows: [{ model: "provider-a/model-a", label: "Model A" }, { model: "provider-b/model-b", label: "Model B" }] };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
function pair({ typed = "", display = "Model A", type = "user", version = "2.1.319", suffix = "", command = "model" } = {}) {
  const promptId = randomUUID();
  const first = { type, ...(type === "system" ? { subtype: "local_command" } : {}), uuid: randomUUID(), promptId,
    sessionId: SESSION, version, timestamp: "2026-11-06T18:00:00.000Z" };
  const second = { ...first, uuid: randomUUID(), parentUuid: first.uuid };
  const commandText = `<command-name>/${command}</command-name>\n <command-message>${command}</command-message>\n <command-args>${typed}</command-args>`;
  const stdout = `<local-command-stdout>Set model to \`${display}\` and saved as your default for new sessions${suffix}</local-command-stdout>`;
  if (type === "user") { first.message = { role: "user", content: commandText }; second.message = { role: "user", content: stdout }; }
  else { first.content = commandText; second.content = stdout; }
  return [first, second];
}
const values = (rows, catalog = CATALOG) => confirmedModelCommands(jsonl(rows), { catalog, session: SESSION }).map((s) => s.value);

for (const type of ["user", "system"]) {
  test(`${type}: empty-argument picker completion maps its label, without a following request`, () => {
    assert.deepEqual(values(pair({ type })), ["provider-a/model-a"]);
  });
}

test("same-model re-picks remain distinct completions, including a reassertion after an external edit", () => {
  const rows = [...pair(), ...pair()];
  const selected = confirmedModelCommands(jsonl(rows), { catalog: CATALOG, session: SESSION });
  assert.deepEqual(selected.map((s) => s.value), ["provider-a/model-a", "provider-a/model-a"]);
  assert.deepEqual(selected.map((s) => s.recordUuid), [rows[1].uuid, rows[3].uuid]);
});

test("A to B to A is native record order, not value deduplication or timestamp order", () => {
  const rows = [...pair(), ...pair({ display: "Model B" }), ...pair()];
  rows[5].timestamp = "2026-11-06T17:00:00.000Z";
  assert.deepEqual(values(rows), ["provider-a/model-a", "provider-b/model-b", "provider-a/model-a"]);
});

for (const typed of ["provider-a/model-a", "Model A"]) {
  test(`typed ${typed}: exact catalog value or unique label maps to the declared value`, () => {
    assert.deepEqual(values(pair({ typed, type: "system" })), ["provider-a/model-a"]);
  });
}
for (const typed of ["a", "model-a", "MODEL A"]) {
  test(`typed ${typed}: an alias, unqualified id or case guess is unresolved`, () => {
    assert.deepEqual(values(pair({ typed, type: "system" })), [null]);
  });
}

test("selectionValue: explicit Default is empty string, not unresolved null or the displayed resolved model", () => {
  assert.deepEqual(values(pair({ display: "Model A (default)" })), [""]);
});
for (const [name, catalog] of [
  ["unknown catalog", { problem: "unreadable policy", rows: [] }],
  ["duplicate labels", { rows: [...CATALOG.rows, { model: "provider-z/model-z", label: "Model A" }] }],
]) {
  test(`${name}: completion is retained as unresolved, never guessed`, () => {
    assert.deepEqual(values(pair(), catalog), [null]);
  });
}

test("reserved Default label collision cannot turn a custom model into Default", () => {
  assert.deepEqual(values(pair({ display: "Model A (default)" }), { rows: [{ model: "a", label: "Model A (default)" }] }), [null]);
});

test("unknown display is an unresolved completion rather than a provider-name invention", () => {
  assert.deepEqual(values(pair({ display: "Model A (1M context)" })), [null]);
});

test("later main-thread request identity cannot change the selected value", () => {
  assert.deepEqual(values([...pair(), { type: "assistant", sessionId: SESSION, requestedModel: "provider-b/model-b", message: { model: "model-b" } }]), ["provider-a/model-a"]);
});

for (const [name, change] of [
  ["cancel", (r) => { r.message.content = r.message.content.replace("Set model to", "Kept model as"); }],
  ["unquoted old era", (r) => { r.version = "2.1.220"; r.message.content = r.message.content.replaceAll("`", ""); }],
  ["meta", (r) => { r.isMeta = true; }],
  ["sidechain", (r) => { r.isSidechain = true; }],
  ["quoted prose", (r) => { r.message.content = "quoted: " + r.message.content; }],
  ["different native session", (r) => { r.sessionId = "other-session"; }],
  ["malformed native UUID", (r) => { r.uuid = "not-a-native-uuid"; }],
]) {
  test(`${name} is not a completion witness`, () => {
    const rows = pair({ typed: "provider-a/model-a" });
    change(rows[1]);
    assert.deepEqual(values(rows), []);
  });
}
for (const command of ["config", "fast"]) {
  test(`/${command} is not an approved /model witness`, () => {
    assert.deepEqual(values(pair({ command, typed: "provider-a/model-a" })), []);
  });
}

test("only the documented optional second line and SGR escapes are accepted", () => {
  const rows = pair({ suffix: '\u001b[2m\n  ANTHROPIC_MODEL is set to `another-model` — new sessions use that while it is set\u001b[22m' });
  assert.deepEqual(values(rows), ["provider-a/model-a"]);
  assert.deepEqual(values(pair({ suffix: "\nnot a recognized confirmation tail" })), []);
});
