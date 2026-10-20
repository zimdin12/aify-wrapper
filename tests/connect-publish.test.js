// The registry publish: one cooperating writer at a time, a CAS on the reread, and a commit boundary read back.
//
// Faults are injected through the `io` seam with a real filesystem underneath, so each case is the real code
// meeting one failure, not a model of it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { COMMITTED, NOT_COMMITTED, UNKNOWN, acquireLock, publish, releaseLock, snapshot } from "../lib/registry-publish.mjs";

function registry(text = "{\"version\":1,\"services\":{}}\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-publish-"));
  const file = path.join(dir, "services.json");
  if (text !== null) fs.writeFileSync(file, text);
  return file;
}

test("a publish onto an unchanged registry commits, and releases its lock", async () => {
  const file = registry();
  const before = snapshot(file);
  const result = await publish(file, "{\"new\":true}\n", before.hash);
  assert.equal(result.result, COMMITTED);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"new\":true}\n");
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test("an absent registry is an empty snapshot, and a first publish commits", async () => {
  const file = registry(null);
  const before = snapshot(file);
  assert.equal(before.bytes.length, 0);
  assert.equal((await publish(file, "{}\n", before.hash)).result, COMMITTED);
});

test("WRITER EXCLUSION: a held lock blocks the publish, which fails naming the holder and writes nothing", async () => {
  const file = registry();
  fs.writeFileSync(`${file}.lock`, "{\"pid\":4242,\"who\":\"another connect\"}");
  const before = snapshot(file);
  await assert.rejects(publish(file, "{\"new\":true}\n", before.hash, { waitMs: 300 }), /held by .*4242.*never taken over/);
  assert.deepEqual(fs.readFileSync(file), before.bytes);
  assert.ok(fs.existsSync(`${file}.lock`), "the other writer's lock was not stolen");
});

test("WRITER EXCLUSION: a write that lands between prepare and the locked reread aborts the publish", async () => {
  const file = registry();
  const before = snapshot(file);
  fs.writeFileSync(file, "{\"version\":1,\"services\":{\"theirs\":{}}}\n");
  const result = await publish(file, "{\"mine\":true}\n", before.hash);
  assert.equal(result.result, NOT_COMMITTED);
  assert.match(fs.readFileSync(file, "utf8"), /theirs/);
});

test("COMMIT BOUNDARY: a rename that succeeds with a readback that fails is unknown, never not-committed", async () => {
  const file = registry();
  const before = snapshot(file);
  let renamed = false;
  const io = {
    ...fs,
    renameSync: (...args) => { fs.renameSync(...args); renamed = true; },
    readFileSync: (target, ...rest) => {
      if (renamed && target === file) throw Object.assign(new Error("readback failed"), { code: "EIO" });
      return fs.readFileSync(target, ...rest);
    },
  };
  const result = await publish(file, "{\"new\":true}\n", before.hash, { io });
  assert.equal(result.result, UNKNOWN);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"new\":true}\n", "CONTROL: the write did land");
});

test("COMMIT BOUNDARY: a rename that fails leaves the old text and reports not-committed", async () => {
  const file = registry();
  const before = snapshot(file);
  const io = { ...fs, renameSync: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } };
  const result = await publish(file, "{\"new\":true}\n", before.hash, { io });
  assert.equal(result.result, NOT_COMMITTED);
  assert.deepEqual(fs.readFileSync(file), before.bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")), [], "no temp file is left");
});

test("a lock is released only by the connect that holds it", async () => {
  const file = registry();
  const held = await acquireLock(file);
  releaseLock({ lockPath: held.lockPath, token: "someone else's token" });
  assert.ok(fs.existsSync(held.lockPath));
  releaseLock(held);
  assert.ok(!fs.existsSync(held.lockPath));
});
