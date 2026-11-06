// Native positions/fences, not hook timing, preserve repeat choices and prevent resume-history replay.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TranscriptCursor } from "../lib/model-transcript-cursor.mjs";

const SESSION = "11111111-2222-3333-4444-555555555555";
const catalog = { rows: [{ model: "provider/a", label: "A" }, { model: "provider/b", label: "B" }] };
function choice(display = "A") {
  const command = { type: "user", version: "2.1.319", sessionId: SESSION, uuid: randomUUID(), promptId: randomUUID(), timestamp: "2026-11-06T18:00:00.000Z",
    message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" } };
  const done = { ...command, uuid: randomUUID(), parentUuid: command.uuid,
    message: { role: "user", content: `<local-command-stdout>Set model to \`${display}\` and saved as your default for new sessions</local-command-stdout>` } };
  return { command, done, text: JSON.stringify(command) + "\n" + JSON.stringify(done) + "\n" };
}
function fixture(t, old = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-model-cursor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${SESSION}.jsonl`); fs.writeFileSync(file, old);
  return { dir, file, captured: TranscriptCursor.capture({ file, session: SESSION }) };
}
function scan(state) { return new TranscriptCursor(state).scan({ catalog }); }

test("resumed historical choices are fenced before new runtime input", (t) => {
  const old = choice("B"); const f = fixture(t, old.text);
  const empty = scan(f.captured.state);
  assert.equal(empty.problem, ""); assert.equal(empty.selection, null);
  const fresh = choice("A"); fs.appendFileSync(f.file, fresh.text);
  const result = scan(empty.state);
  assert.equal(result.selection.value, "provider/a");
  assert.equal(result.selection.endOffset, Buffer.byteLength(old.text + fresh.text));
  assert.equal(result.selection.recordUuid, fresh.done.uuid);
});

test("repeat A, A to B to A and unresolved each retain their later native positions", (t) => {
  const f = fixture(t); let state = f.captured.state; const positions = [];
  for (const display of ["A", "A", "B", "A", "unknown"]) {
    fs.appendFileSync(f.file, choice(display).text);
    const result = scan(state); assert.equal(result.problem, "");
    positions.push(result.selection.endOffset); assert.equal(result.selection.value, display === "unknown" ? null : `provider/${display.toLowerCase()}`);
    state = result.state;
  }
  assert.equal(new Set(positions).size, 5);
  assert.ok(positions.every((p, i) => i === 0 || p > positions[i - 1]));
  assert.equal(scan(state).selection, null, "unchanged transcript was replayed");
});

test("one scan returns the latest native completion, even with no request between choices", (t) => {
  const f = fixture(t); fs.appendFileSync(f.file, choice("A").text + choice("B").text + choice("A").text);
  const result = scan(f.captured.state);
  assert.equal(result.selection.value, "provider/a"); assert.equal(result.selection.endOffset, fs.statSync(f.file).size);
});

test("command/confirmation split across scans keeps its exact pairing", (t) => {
  const f = fixture(t); const selected = choice();
  fs.appendFileSync(f.file, JSON.stringify(selected.command) + "\n");
  const first = scan(f.captured.state); assert.equal(first.selection, null);
  fs.appendFileSync(f.file, JSON.stringify(selected.done) + "\n");
  const second = scan(first.state);
  assert.equal(second.selection.recordUuid, selected.done.uuid);
});

test("an incomplete new record waits for its newline", (t) => {
  const f = fixture(t); const selected = choice(); const complete = JSON.stringify(selected.done);
  fs.appendFileSync(f.file, JSON.stringify(selected.command) + "\n" + complete.slice(0, 50));
  const first = scan(f.captured.state); assert.equal(first.selection, null);
  fs.appendFileSync(f.file, complete.slice(50) + "\n");
  assert.equal(scan(first.state).selection.recordUuid, selected.done.uuid);
});

test("a partial record present before launch never becomes a postlaunch choice", (t) => {
  const selected = choice(); const line = JSON.stringify(selected.command); const f = fixture(t, line.slice(0, 60));
  fs.appendFileSync(f.file, line.slice(60) + "\n" + JSON.stringify(selected.done) + "\n");
  const result = scan(f.captured.state); assert.equal(result.selection, null);
  fs.appendFileSync(f.file, choice("B").text);
  assert.equal(scan(result.state).selection.value, "provider/b", "skipping old partial history blocked new useful work");
});

for (const kind of ["truncate", "replace", "rewrite anchor"]) {
  test(`${kind}: refuse discontinuity, do not reset to zero or advance state`, (t) => {
    const f = fixture(t, choice().text); const before = JSON.stringify(f.captured.state);
    if (kind === "truncate") fs.writeFileSync(f.file, "");
    if (kind === "replace") { fs.renameSync(f.file, f.file + ".old"); fs.writeFileSync(f.file, choice("B").text); }
    if (kind === "rewrite anchor") { const data = fs.readFileSync(f.file); data[data.length - 2] = 32; fs.writeFileSync(f.file, data); }
    const result = scan(f.captured.state);
    assert.notEqual(result.problem, ""); assert.equal(result.selection, null);
    assert.equal(JSON.stringify(f.captured.state), before, "reader mutated the caller's cursor");
  });
}

// A persisted fence must be a real native position; comparison with undefined/NaN must not admit replay.
for (const fence of [undefined, Number.NaN, 0.5]) {
  test(`unsafe persisted fence ${String(fence)} refuses without advancing`, (t) => {
    const f = fixture(t, "{}\n"); const state = { ...f.captured.state, fence };
    fs.appendFileSync(f.file, choice().text);
    const result = scan(state);
    assert.match(result.problem, /invalid cursor/); assert.equal(result.selection, null); assert.deepEqual(result.state, state);
  });
}

test("UTF-8 byte offsets, not string lengths, order later records", (t) => {
  const f = fixture(t, JSON.stringify({ text: "é🙂" }) + "\n"); fs.appendFileSync(f.file, choice().text);
  assert.equal(scan(f.captured.state).selection.endOffset, fs.statSync(f.file).size);
});
