#!/usr/bin/env node
// `herdr-aify --prune`: deleting what dead invocations left behind, and nothing else.
//
// WHY IT EXISTS. Every launch mints a directory under `~/.aify/herdr/invocations/` and nothing ever
// removed one. Twelve accumulated in a day of testing, and `--status` -- the command an operator
// reaches for when something is wrong -- prints all of them, so the useful line sinks under the
// residue of launches that failed weeks ago.
//
// WHAT THESE TESTS ARE ACTUALLY FOR. Not the deleting, which is one call; the DECIDING. A prune that
// removes the directory of a RUNNING instance takes away its context file and its receipts, and
// those receipts are the whole no-resurrection guarantee -- the thing that stops the next invocation
// adopting the previous one's workers. So the property under test is what SURVIVES, driven by a
// probe that is made to answer, never by a flag set beside the thing it describes.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { invocationsOnDisk, prunePlan, pruneInvocations } from "../bin/herdr-aify.mjs";

/** A profile root holding the invocations named, each with the receipts of a finished launch. */
function profileWith(invocations, { spent = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-prune-"));
  for (const invocation of invocations) {
    const dir = path.join(root, "invocations", invocation);
    fs.mkdirSync(dir, { recursive: true });
    if (spent) fs.writeFileSync(path.join(dir, "ready.json"), "{}");
  }
  return root;
}

test("a live invocation is kept and a dead one goes", () => {
  const live = randomUUID();
  const dead = randomUUID();
  const plan = prunePlan(
    [{ invocation: live, root: "a" }, { invocation: dead, root: "b" }],
    { live: [live] },
  );
  assert.deepEqual(plan.remove.map(r => r.invocation), [dead]);
  assert.deepEqual(plan.keep.map(r => r.invocation), [live]);
  assert.equal(plan.keep[0].why, "still answering");
});

test("a directory that is not an invocation is left alone, because nothing here put it there", () => {
  const plan = prunePlan([{ invocation: "notes", root: "x" }, { invocation: "0f13610", root: "y" }], { live: [] });
  assert.equal(plan.remove.length, 0);
  assert.deepEqual(plan.keep.map(r => r.why), ["not an invocation", "not an invocation"]);
});

test("nothing answering means everything goes; nothing recorded means nothing goes", () => {
  const ours = [randomUUID(), randomUUID()].map(invocation => ({ invocation, root: invocation }));
  assert.equal(prunePlan(ours, { live: [] }).remove.length, 2);
  assert.equal(prunePlan([], { live: [] }).remove.length, 0);
});

test("THE WHOLE COMMAND: the one whose socket answers still has its receipts afterwards", () => {
  // THE PROBE IS DRIVEN, NOT DECLARED. A test that handed `prunePlan` a live list would prove the
  // decision and leave the command unproven -- which is the shape of defect this feature has already
  // shipped twice. Here the fake CLI answers for exactly one invocation, the way a running Herdr
  // answers on its own socket, and the assertion is on the FILESYSTEM afterwards.
  const live = randomUUID();
  const dead = [randomUUID(), randomUUID()];
  const profileRoot = profileWith([live, ...dead]);
  const asked = [];

  const code = pruneInvocations({
    profileRoot,
    env: {},
    cli: (argv, { env }) => {
      asked.push(env.HERDR_SOCKET_PATH);
      // AS HERDR REALLY ANSWERS: a live socket succeeds, a dead one says `server_not_running` in its
      // body. A bare `{ok: false}` is what a TIMEOUT looks like, and a timeout must delete nothing.
      return String(env.HERDR_SOCKET_PATH).includes(live)
        ? { ok: true, error: null, code: null }
        : { ok: false, error: "herdr exited 1", code: "server_not_running" };
    },
  });

  assert.equal(code, 0);
  assert.equal(asked.length, 3, "every invocation must be probed before anything is deleted");
  assert.ok(
    fs.existsSync(path.join(profileRoot, "invocations", live, "ready.json")),
    "the running instance lost the receipts that stop the next one adopting its workers",
  );
  for (const gone of dead) {
    assert.equal(fs.existsSync(path.join(profileRoot, "invocations", gone)), false, "a dead invocation survived");
  }
  assert.deepEqual(invocationsOnDisk({ profileRoot }).map(r => r.invocation), [live]);
});

test("NEGATIVE CONTROL: with nothing answering, the same run removes the one it just kept", () => {
  // The instrument must be able to say the opposite. Same profile, same command, probe answering for
  // nobody -- so the survival above is a consequence of the probe and not of the code path.
  const live = randomUUID();
  const profileRoot = profileWith([live, randomUUID()]);
  pruneInvocations({ profileRoot, env: {}, cli: () => ({ ok: false, error: "herdr exited 1", code: "server_not_running" }) });
  assert.equal(fs.existsSync(path.join(profileRoot, "invocations", live)), false);
  assert.deepEqual(invocationsOnDisk({ profileRoot }), []);
});

test("AN INVOCATION THAT COULD NOT BE ASKED KEEPS ITS RECEIPTS", () => {
  // Found by review. The probe was `.ok`, so a Herdr that timed out -- busy, not dead -- lost its
  // context file and the receipts that stop a later launch adopting its workers. Only Herdr saying
  // `server_not_running` may delete; everything else is kept and named.
  const slow = randomUUID();
  const dead = randomUUID();
  const profileRoot = profileWith([slow, dead]);
  pruneInvocations({
    profileRoot,
    env: {},
    cli: (argv, { env }) => (String(env.HERDR_SOCKET_PATH).includes(slow)
      ? { ok: false, error: "spawnSync herdr ETIMEDOUT", code: null }
      : { ok: false, error: "herdr exited 1", code: "server_not_running" }),
  });
  assert.ok(fs.existsSync(path.join(profileRoot, "invocations", slow, "ready.json")), "a slow instance lost its receipts");
  assert.equal(fs.existsSync(path.join(profileRoot, "invocations", dead)), false, "the control: a dead one is still removed");
});

test("the plan names WHY an unanswered invocation was kept", () => {
  const id = randomUUID();
  const plan = prunePlan([{ invocation: id, root: "r" }], { live: [], unknown: [id] });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep[0].why, "could not tell whether it is running");
});
