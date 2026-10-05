#!/usr/bin/env node
// Every launcher this package renders must satisfy aify-env's execution contract.
//
// aify-env runs processes on behalf of whichever service asks, which is remote code execution unless
// something constrains what it will run. Its constraint is derived rather than listed: a file may run
// if it opens with a shebang AND carries HARNESS_WRAPPER_VERSION as a real assignment at the start of a
// line. Installing a launcher enrols it; nobody edits a policy file.
//
// THE CONTRACT IS ASSERTED THERE AND NOWHERE HERE, which is the gap this closes. aify-env's positive
// control -- "a real launcher is accepted" -- reads a RECORDED copy of one of our launchers. A recording
// cannot notice when the thing it recorded changes. Switch the marker to single quotes, or let anything
// precede the shebang, and aify-env would refuse every launcher on the host while its own suite stayed
// green on the old recording. The blast radius is every managed agent, and the failure would look like
// aify-env being broken rather than like a template edit.
//
// Both of those were run against this file before it was trusted, and each reddens it. A third -- an
// INDENTED marker -- does not, and finding that out is what corrected this comment: aify-env's regex
// begins `^[ 	]*`, so leading whitespace is explicitly tolerated and an indented marker is not a
// violation at all. The prose said it was until the mutation disagreed.
//
// The predicates below are RESTATED rather than imported: these repos are deliberately independent, and
// aify-env is not a dependency of this package. Restating a rule across a boundary is duplication that
// has to be paid for, and this is the payment -- if aify-env's allowlist changes, this file is the one
// that has to change with it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");

/** Set, and reachable by nothing. A rendered launcher must never find a real service. */
const NOWHERE = "http://127.0.0.2:1";

const CLIENTS = [
  { client: "claude", names: ["claude-aify"] },
  { client: "codex", names: ["codex-aify"] },
  { client: "hermes", names: ["hermes-aify"] },
  { client: "pi", names: ["pi-aify", "omp-aify"] },
];

/** aify-env's lib/allowlist.mjs, verbatim in meaning. */
const SHEBANG = /^#![ \t]*\S/;
const MARKER = /^[ \t]*HARNESS_WRAPPER_VERSION[ \t]*=[ \t]*"([^"]*)"[ \t]*$/m;
const UNSUBSTITUTED = /^[ \t]*HARNESS_WRAPPER_VERSION[ \t]*=[ \t]*"@@[A-Z0-9_]+@@"/m;

function render(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-env-contract-${client}-`));
  execFileSync("bash", [INSTALL, "--client", client, "--endpoint", NOWHERE, "--render-only", dir], {
    encoding: "utf8",
  });
  return dir;
}

for (const { client, names } of CLIENTS) {
  test(`${client}: every rendered launcher would be accepted by aify-env`, () => {
    const dir = render(client);
    try {
      for (const name of names) {
        const text = fs.readFileSync(path.join(dir, name), "utf8");

        assert.match(text, SHEBANG, `${name} does not open with a shebang; aify-env refuses it`);

        const marker = MARKER.exec(text);
        assert.notEqual(marker, null, `${name} has no HARNESS_WRAPPER_VERSION assignment at a line start`);
        assert.notEqual(marker[1].trim(), "", `${name} declares an empty contract version`);

        assert.doesNotMatch(
          text,
          UNSUBSTITUTED,
          `${name} still carries an unsubstituted placeholder, which aify-env refuses by name`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the marker predicate is strict enough to be worth asserting", () => {
  // A control on the rule itself. A substring check would accept a file that merely MENTIONS the name,
  // which is how aify-env's own README once passed its allowlist. If this regex ever loosens to that,
  // the tests above become decoration and this one says so.
  assert.equal(MARKER.test('# see HARNESS_WRAPPER_VERSION="1.0" in the docs'), false);
  assert.equal(MARKER.test("HARNESS_WRAPPER_VERSION='0.6.0'"), false, "single quotes are not the form");
  assert.equal(MARKER.test('HARNESS_WRAPPER_VERSION="0.6.0"'), true);
});
