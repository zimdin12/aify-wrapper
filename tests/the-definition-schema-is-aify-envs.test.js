#!/usr/bin/env node
// lib/agent-definition-schema.mjs is aify-env's validator, held to aify-env's bytes (P0 C1, C9).
//
// A COPY, NOT A PORT. A launcher must validate a definition exactly as the store that wrote it does,
// and a second implementation is a second opinion that drifts. So this file is aify-env's module byte
// for byte, and this test fails on any difference. Its exports (SCHEMA_VERSION, UNAVAILABLE_HARNESS,
// MAX_COUNTER, isCounter, isOperationId, idProblems, numberProblems, definitionBytesProblems,
// definitionProblems, canonicalJson, sha256Hex, definitionDigest, formatDefinitionFile) are aify-env's
// and tested there; here the copy also runs aify-env's shared fixture, so a stale copy fails twice.
//
// THE SIBLING CHECKOUT: `AIFY_ENV_REPO`, else beside this checkout, else ~/projects/aify-env. With none,
// this SKIPS BY NAME: a cross-repo proof that ran nothing must not read as a pass.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { definitionBytesProblems } from "../lib/agent-definition-schema.mjs";
import { definitionsDir } from "../lib/agent-definition-defaults.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join("lib", "agent-definition-schema.mjs");
const CANDIDATES = [process.env.AIFY_ENV_REPO, path.join(ROOT, "..", "aify-env"), path.join(os.homedir(), "projects", "aify-env")].filter(Boolean);
const ENV_REPO = CANDIDATES.find((dir) => fs.existsSync(path.join(dir, SCHEMA)));
const skip = ENV_REPO ? false : `no aify-env checkout with ${SCHEMA} (looked in ${CANDIDATES.join(", ")}): NOT verified`;

test("THE COPY IS aify-env's BYTES", { skip }, () => {
  assert.ok(fs.readFileSync(path.join(ROOT, SCHEMA)).equals(fs.readFileSync(path.join(ENV_REPO, SCHEMA))),
    `lib/agent-definition-schema.mjs differs from ${ENV_REPO}'s: copy it again, byte for byte`);
});

test("THE SHARED FIXTURE: every case gets exactly its expected problems through the copy", { skip }, () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ENV_REPO, "tests", "fixtures", "agent-definitions", "cases.json"), "utf8"));
  assert.ok(fixture.cases.length >= 80, "the fixture lost its cases");
  for (const c of fixture.cases) {
    const bytes = c.rawBase64 !== undefined ? Buffer.from(c.rawBase64, "base64")
      : Buffer.from(c.raw !== undefined ? c.raw : JSON.stringify(c.body), "utf8");
    assert.deepEqual(definitionBytesProblems(bytes, c.fileId, { population: c.population }).problems, c.problems, c.name);
  }
});

test("THE DIRECTORY: what aify-env's store writes, the launcher's reader finds, by default and overridden", { skip }, () => {
  // aify-env does not export its directory (only its store may hold the path), so the two are compared
  // by effect: a child whose home is a temporary directory writes through the real store and reads
  // through this reader. Nothing touches the real home.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-definition-home-"));
  const script = [
    `const { DefinitionStore } = await import(${JSON.stringify(pathToFileURL(path.join(ENV_REPO, "lib", "agent-definitions.mjs")).href)});`,
    `const { definitionsDir, readDefinition } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "agent-definition-defaults.mjs")).href)});`,
    "await new DefinitionStore().set('lead', { name: 'Lead', role: 'reviewer', harness: 'claude', mode: 'resident',",
    "  workspace: 'C:/work', model: '', effort: '', instructions: '', env: {}, herdrSpace: true }, { installed: new Set(['claude']) });",
    "console.log(readDefinition({ id: 'lead', harness: 'claude', dir: definitionsDir() }).outcome);",
  ].join(String.fromCharCode(10));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (key !== "AIFY_AGENT_DEFINITIONS_DIR") env[key] = value;
  for (const extra of [{}, { AIFY_AGENT_DEFINITIONS_DIR: path.join(home, "elsewhere") }]) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...env, HOME: home, USERPROFILE: home, ...extra } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "found", JSON.stringify(extra));
  }
  assert.ok(fs.existsSync(path.join(home, ".aify", "agent-definitions", "lead.json")), "the default run wrote under the temporary home");
});
