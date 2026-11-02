// A confirmed /model is read from Claude's own records (lib/model-selection.mjs). The fixture is the model-sync probe's
// transcript, 2026-11-02, cut to the records that matter and to their identifying fields: a bare id
// (`/model gpt-6.1-sol`) and an alias (`/model sonnet`), each confirmed, each followed by an ordinary prompt.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { confirmedModelCommands, readAppended } from "../lib/model-selection.mjs";

const FIXTURE = fs.readFileSync(fileURLToPath(new URL("./fixtures/claude-model-commands.jsonl", import.meta.url)), "utf8");
const records = FIXTURE.trim().split("\n").map((line) => JSON.parse(line));
const jsonl = (list) => `${list.map((record) => JSON.stringify(record)).join("\n")}\n`;

test("confirmedModelCommands: a bare id and an alias, each with the selector as typed and the name Claude displayed", () => {
  assert.deepEqual(confirmedModelCommands(FIXTURE).map(({ typed, display }) => ({ typed, display })), [
    { typed: "gpt-6.1-sol", display: "gpt-6.1-sol" },
    { typed: "sonnet", display: "Claude Sonnet 5.5" },
  ]);
  const [first] = confirmedModelCommands(FIXTURE);
  assert.equal(first.session, records[1].sessionId);
  assert.equal(first.at, new Date(records[1].timestamp).toISOString());
});

test("a /model with no 'Set model to' answer is no selection, nor is prose that only names /model", () => {
  // The dialog answered No, or the command failed: the command record is there, the confirmation is not.
  const unanswered = records.filter((record) => !String(record.message.content).startsWith("<local-command-stdout>"));
  assert.deepEqual(confirmedModelCommands(jsonl(unanswered)), []);
  const prose = { ...records[3], message: { role: "user", content: "please run <command-name>/model</command-name> <command-args>opus</command-args>" } };
  assert.deepEqual(confirmedModelCommands(jsonl([prose, records[2]])), [], "a confirmation paired with prose");
  assert.deepEqual(confirmedModelCommands(jsonl([records[1], records[6]])), [], "a confirmation paired with another prompt's command");
});

test("a /model made before this launch is not this launch's choice", () => {
  const sinceMs = Date.parse(records[5].timestamp); // the alias command itself
  assert.deepEqual(confirmedModelCommands(FIXTURE, { sinceMs }).map(({ typed }) => typed), ["sonnet"]);
});

test("readAppended: only whole lines since the offset; a line still being written waits; a replaced file starts over", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-model-selection-"));
  try {
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, "a\nb\npart");
    const first = readAppended(file, 0);
    assert.deepEqual(first, { text: "a\nb\n", offset: 4 });
    assert.deepEqual(readAppended(file, first.offset), { text: "", offset: 4 }, "half a line was read");
    fs.appendFileSync(file, "ial\nc\n");
    assert.deepEqual(readAppended(file, first.offset), { text: "partial\nc\n", offset: 14 });
    assert.deepEqual(readAppended(file, 14), { text: "", offset: 14 }, "an unchanged file read anything");
    fs.writeFileSync(file, "new\n");
    assert.deepEqual(readAppended(file, 14), { text: "new\n", offset: 4 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
