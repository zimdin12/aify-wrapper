#!/usr/bin/env node
// The API block in docs/REGISTRY.md is a hand-copy of this module's exports, so it is checked.
//
// MEASURED 2026-09-07, and it had drifted in BOTH directions at once:
//
//   * it documented `endpointFor(registry, name)`, which no version of this module has ever
//     exported -- a reader following the doc calls something that is not there;
//   * it omitted `REGISTRY_VERSION` and the whole strict-MCP half (four functions), so a reader
//     never learned that half existed.
//
// Neither direction is visible from the doc, which is the point: prose that describes code reads
// exactly the same whether or not it is true. An agreement test is cheaper than the alternatives --
// generating the block would put a build step between a contributor and a paragraph, and trusting a
// review to notice is what produced the drift.
//
// IT CHECKS THE BLOCK, NOT THE PROSE. Names in sentences are free to be informal; the fenced list is
// the part a reader copies from.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as registry from "../lib/registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.join(HERE, "..", "docs", "REGISTRY.md");

/** The names in the API block: the identifier at the head of each line, before any `(`. */
function documentedNames() {
  const text = readFileSync(DOC, "utf8");
  const marker = "`lib/registry.mjs`";
  const from = text.indexOf(marker);
  assert.notEqual(from, -1, "docs/REGISTRY.md no longer has an API section -- this test is measuring nothing");
  const open = text.indexOf("```js", from);
  const close = text.indexOf("```", open + 5);
  assert.ok(open !== -1 && close !== -1, "the API section has no fenced js block");

  const names = new Set();
  for (const line of text.slice(open + 5, close).split("\n")) {
    const name = /^([A-Za-z_$][\w$]*)/.exec(line.trim());
    if (name) names.add(name[1]);
  }
  return names;
}

test("POSITIVE CONTROL: the block is read, and it names things", () => {
  // Every assertion below compares two sets. A parse that returned an empty set would satisfy the
  // "nothing undocumented" half and read as green.
  const documented = documentedNames();
  assert.ok(documented.size >= 4, `only parsed ${documented.size} names out of the API block`);
  assert.ok(documented.has("parseRegistry"), "the parse missed a name that is plainly in the block");
});

test("NEGATIVE CONTROL: the parse can say a name is absent", () => {
  // A membership test that answered yes to everything would make the whole file vacuous.
  assert.equal(documentedNames().has("endpointFor"), false,
    "`endpointFor` is documented again -- it has never been exported by this module");
});

test("every documented name is exported", () => {
  const exported = new Set(Object.keys(registry));
  const missing = [...documentedNames()].filter((n) => !exported.has(n));
  assert.deepEqual(missing, [],
    `docs/REGISTRY.md documents ${missing.join(", ")}, which lib/registry.mjs does not export`);
});

test("every export is documented", () => {
  const documented = documentedNames();
  const undocumented = Object.keys(registry).filter((n) => !documented.has(n));
  assert.deepEqual(undocumented, [],
    `lib/registry.mjs exports ${undocumented.join(", ")}, which docs/REGISTRY.md never mentions`);
});
