#!/usr/bin/env node
// The wrapper templates exist TWICE, and only one copy was guarded.
//
// aify-comms renders these same four launchers for hosts that run the service; this package renders
// them for hosts that want launchers WITHOUT it. Two sources of truth for one artifact, which is a
// known and accepted cost until aify-comms consumes this package instead of copying it.
//
// aify-comms guards its side with `test_wrapper_templates_are_published_in_sync.py`, which pins the
// sha256 of each template. That test reads its OWN copies, so it catches an edit made THERE. Nothing
// caught an edit made HERE: this repo could change a template and both suites would stay green while
// the two copies diverged. Measured 2026-08-20 -- all four agreed at that moment, so this closes a hole
// rather than repairing a break.
//
// The two gates pin the same digests deliberately. Changing a template means editing it in both repos
// and updating both hash tables in the same change; whichever side you forget goes red in its own
// suite, which is the property a single-sided gate could not give.
//
// WHY HASHES RATHER THAN READING THE OTHER REPO: it is not on this machine in general, and a test that
// silently skips when a path is absent is a test that reports green having checked nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WRAPPERS = join(dirname(fileURLToPath(import.meta.url)), "..", "wrappers");

/**
 * sha256 of each template as published in aify-comms, MEASURED 2026-08-20 against that repo's working
 * tree and cross-checked against the hash table in its own gate.
 */
const PUBLISHED = {
  "claude-aify.sh.in": "1b7ff4e82d15199ce0d0bc4d02a0ecafe4e9c3cde57d05c3bed8f9f13ba30ca8",
  "codex-aify.sh.in": "7e4d0480fbbded52440f0f90b170fc5b24e8648ae9f7c28ab50e72d10f1d25bf",
  "hermes-aify.sh.in": "aea6fcc2a43d97c72f1c54b093ea2b4df23d5ebc0b3852ad4af69859af87455d",
  "pi-aify.sh.in": "cdfc2e3789c6e60c363d61b531b25b1ebf3314c8108bff914e6808ca046719f1",
};

/** Hashed as BYTES. Decoding to text would let a line-ending rewrite pass as identical. */
const digest = (name) => createHash("sha256").update(readFileSync(join(WRAPPERS, name))).digest("hex");

for (const [name, expected] of Object.entries(PUBLISHED)) {
  test(`${name} is byte-identical to the copy aify-comms publishes`, () => {
    assert.equal(
      digest(name),
      expected,
      `${name} differs from the aify-comms copy. Sync the two and update BOTH hash tables in the same `
      + "change -- this one and test_wrapper_templates_are_published_in_sync.py.",
    );
  });
}

test("every template in this directory is covered by a hash", () => {
  // Derived, not listed. A fifth wrapper added here with no entry would otherwise be unguarded, and an
  // unguarded file reports green exactly like a guarded one.
  const onDisk = readdirSync(WRAPPERS).filter((name) => name.endsWith(".sh.in")).sort();
  assert.deepEqual(
    onDisk,
    Object.keys(PUBLISHED).sort(),
    "a template here has no published hash, or a hash names a template that is gone",
  );
});
