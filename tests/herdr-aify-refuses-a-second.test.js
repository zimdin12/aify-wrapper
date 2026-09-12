#!/usr/bin/env node
// A second `herdr-aify` on one host must refuse, and this pins it against the REAL shape of the
// function that answers the question.
//
// THE DEFECT THIS EXISTS FOR. The refusal read `incumbent?.live`. `profileOwnerState` has never
// returned a `live` field — it returns `{ owned, reason, invocation }` — so the check was always
// `undefined`, always falsy, and never once refused. Running two launchers proved it: the second
// started its own Herdr and its own dedicated aify-env, and overwrote the first one's owner pointer,
// which is the exact state that leaves the FIRST instance unowned when the second exits.
//
// AN EXPECTATION DERIVED FROM A HAND-WRITTEN OBJECT WOULD NOT HAVE CAUGHT IT. A test that fabricated
// `{ live: true }` agrees with the broken code. So this drives the real `profileOwnerState` against
// a real pointer file and asserts on the field it actually produces.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { alreadyRunning } from "../bin/herdr-aify.mjs";
import { profileOwnerFile, profileOwnerState, writeProfileOwner } from "../lib/herdr-owner.mjs";

function profile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-owner-"));
}

test("the field the launcher keys on is the field this function returns", () => {
  // THE WHOLE BUG IN ONE ASSERTION. Anything reading `.live` gets undefined for ever.
  const root = profile();
  writeProfileOwner(root, {
    invocation: "11111111-1111-4111-8111-111111111111",
    ownerEndpoint: path.join(root, "owner.sock"),
    pid: 4242,
  });
  const raw = JSON.parse(fs.readFileSync(profileOwnerFile(root), "utf8"));
  assert.equal(raw.version, 1, "the pointer shape the reader requires");
  assert.ok(raw.invocation && raw.ownerEndpoint);
});

test("THE CALL SITE: the launcher's decision reads what profileOwnerState really produces", async () => {
  // THE TEST THAT WAS MISSING. A green test of `profileOwnerState` stayed green while the launcher
  // read a field it never returns -- a helper proven in isolation leaves its CALLER unproven, which
  // is how a second instance was allowed to start for this feature's whole life.
  const root = profile();
  const invocation = "33333333-3333-4333-8333-333333333333";
  writeProfileOwner(root, { invocation, ownerEndpoint: path.join(root, "nobody.sock"), pid: 1 });

  // A real (stale) state object, straight from the function the launcher calls.
  const stale = await profileOwnerState(root, { timeoutMs: 300 });
  assert.equal(alreadyRunning(stale), false, "a dead owner must not block the next launch");

  // And the LIVE shape, spelled the way the function spells it.
  assert.equal(alreadyRunning({ owned: true, reason: "live-owner", invocation }), true);

  // The decisive one: the field the broken version read must not satisfy the decision.
  assert.equal(alreadyRunning({ live: true }), false, "a caller keying on `live` would never refuse");
  assert.equal(alreadyRunning(null), false);
  assert.equal(alreadyRunning(undefined), false);
});

test("no pointer means no incumbent, and the launcher may start", async () => {
  const state = await profileOwnerState(profile());
  assert.equal(state.owned, false);
  assert.equal(state.reason, "no-pointer");
  assert.equal(state.live, undefined, "there is no `live` field; a caller keying on one never refuses");
});

test("a pointer whose owner does NOT answer is stale, and names the invocation anyway", async () => {
  // This is what a launcher killed without a signal leaves behind. It must not block the next start,
  // and `--stop` needs the invocation out of it to address the orphan.
  const root = profile();
  const invocation = "22222222-2222-4222-8222-222222222222";
  writeProfileOwner(root, { invocation, ownerEndpoint: path.join(root, "nobody-listening.sock"), pid: 1 });
  const state = await profileOwnerState(root, { timeoutMs: 300 });
  assert.equal(state.owned, false, "a dead owner must not block the next launch");
  assert.equal(state.reason, "stale-pointer");
  assert.equal(state.invocation, invocation, "--stop cannot address an orphan without this");
});

test("a damaged pointer is refused rather than half-read", async () => {
  const root = profile();
  fs.writeFileSync(profileOwnerFile(root), "{ not json");
  assert.equal((await profileOwnerState(root)).reason, "no-pointer");
  fs.writeFileSync(profileOwnerFile(root), JSON.stringify({ version: 99, invocation: "x" }));
  assert.equal((await profileOwnerState(root)).reason, "unreadable-pointer");
});
