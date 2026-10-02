#!/usr/bin/env node
// The launcher's reader of an agent definition (P0 C9), as functions and as the command launchers run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { definitionsDir, EXIT_REFUSED, readDefinition, shellAssignments } from "../lib/agent-definition-defaults.mjs";

const COMMAND = fileURLToPath(new URL("../bin/aify-definition.mjs", import.meta.url));
const body = (over = {}) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "claude",
  mode: "resident", workspace: "C:/work", model: "opus", effort: "high", instructions: "", env: {}, herdrSpace: true, ...over } });
const dirWith = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-definition-read-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};

test("definitionsDir: the test override, else aify-env's default under the home", () => {
  assert.equal(definitionsDir({ AIFY_AGENT_DEFINITIONS_DIR: "/x" }, "/home/u"), "/x");
  assert.equal(definitionsDir({}, "/home/u"), path.join("/home/u", ".aify", "agent-definitions"));
});

test("readDefinition: found, missing, and every refusal", () => {
  const dir = dirWith({ "lead.json": JSON.stringify(body()), "bad.json": "{ not json", "other.json": JSON.stringify(body({ id: "other", harness: "codex" })) });
  assert.deepEqual(readDefinition({ id: "lead", harness: "claude", dir }),
    { outcome: "found", file: path.join(dir, "lead.json"), role: "reviewer", model: "opus", effort: "high" });
  assert.deepEqual(readDefinition({ id: "nobody", harness: "claude", dir }), { outcome: "missing", file: path.join(dir, "nobody.json") });
  assert.deepEqual(readDefinition({ id: "bad", harness: "claude", dir }).problems, ["file: not-json"]);
  assert.deepEqual(readDefinition({ id: "other", harness: "claude", dir }).problems, ["it defines a codex agent, and this is the claude launcher"]);
  assert.equal(readDefinition({ id: "../lead", harness: "claude", dir }).outcome, "refused", "an id that is not admitted is never a path");
  fs.mkdirSync(path.join(dir, "folder.json"));
  assert.deepEqual(readDefinition({ id: "folder", harness: "claude", dir }).problems, ["entry: not-a-regular-file"]);
  const denied = { lstatSync: () => ({ isFile: () => true }), readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  assert.deepEqual(readDefinition({ id: "lead", harness: "claude", dir, io: denied }).problems, ["file: unreadable (EACCES)"],
    "unreadable is refused, never read as missing");
});

test("shellAssignments: quoted for bash, a quote inside a value included", () => {
  assert.deepEqual(shellAssignments({ outcome: "missing", file: "/d/x.json" }), ["AIFY_DEF_FILE=''"]);
  assert.deepEqual(shellAssignments({ outcome: "found", file: "/d/x.json", role: "r", model: "it's", effort: "" }),
    ["AIFY_DEF_FILE='/d/x.json'", "AIFY_DEF_ROLE='r'", "AIFY_DEF_MODEL='it'\\''s'", "AIFY_DEF_EFFORT=''", "AIFY_DEF_CONTROL=''"]);
  // A control character cannot cross the shell (bash drops a NUL, Git Bash a CR), so its field is named.
  assert.equal(shellAssignments({ outcome: "found", file: "f", role: "r", model: "a\u0000b", effort: "x\ry" }).at(-1),
    "AIFY_DEF_CONTROL='model effort'");
  assert.equal(shellAssignments({ outcome: "found", file: "f", role: "r", model: "m", effort: "a\u0085" }).at(-1),
    "AIFY_DEF_CONTROL='effort'", "C1 controls count, as the schema counts them for a name");
  const evaluated = spawnSync("bash", ["-c", `${shellAssignments({ outcome: "found", file: "f", role: "r", model: "it's $(x)", effort: "" }).join("; ")}; printf %s "$AIFY_DEF_MODEL"`], { encoding: "utf8" });
  assert.equal(evaluated.stdout, "it's $(x)", "bash reads the value back exactly, nothing expanded");
});

test("THE COMMAND: assignments and 0, or the problems and EXIT_REFUSED", () => {
  const dir = dirWith({ "lead.json": JSON.stringify(body()), "bad.json": "{" });
  const run = (...args) => spawnSync(process.execPath, [COMMAND, ...args], { encoding: "utf8", env: { ...process.env, AIFY_AGENT_DEFINITIONS_DIR: dir } });
  const found = run("lead", "claude");
  assert.equal(found.status, 0);
  assert.match(found.stdout, /^AIFY_DEF_ROLE='reviewer'$/m);
  const bad = run("bad", "claude");
  assert.equal(bad.status, EXIT_REFUSED);
  assert.match(bad.stderr, /the definition of bad .* is refused: file: not-json/);
  assert.equal(run("nobody", "claude").stdout, "AIFY_DEF_FILE=''\n");
});
