#!/usr/bin/env node
// The owner answers the challenge aify-env actually sends, and says "already running" to a second launch.
//
// THE STRONGEST TEST HERE RUNS THE OTHER REPO'S CODE. `prepareInstance` is what a dedicated daemon
// calls before it will start: it reads the context, demands advertisement be off, demands an empty
// service registry, and challenges the owner endpoint. Importing it starts nothing — it is I/O and
// policy, not the daemon — so the whole admission path can be driven here against a real owner, and
// a mismatch shows up as a failing assertion instead of as a daemon that times out in two seconds
// with `owner authorization refused` and no clue which half was wrong.
//
// EVERY REFUSAL IS DRIVEN BY REMOVING WHAT IT WATCHES: stop the owner, point the challenge at another
// invocation, put a service in the registry, leave advertisement on. A test that only ever shows the
// happy path cannot tell an admission gate from an open door.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { buildInstanceContext, writeInstanceContext } from "../lib/herdr-instance.mjs";
import {
  HerdrOwner,
  challengeVerdict,
  clearProfileOwner,
  profileOwnerFile,
  profileOwnerState,
  probeOwner,
  replyTo,
  writeProfileOwner,
} from "../lib/herdr-owner.mjs";

const ENV_REPO = process.env.AIFY_ENV_REPO || path.join(os.homedir(), "projects", "aify-env");

const envBootstrap = await (async () => {
  const file = path.join(ENV_REPO, "lib", "instance-bootstrap.mjs");
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
})();
const skipWithoutEnv = envBootstrap ? false : `no aify-env checkout at ${ENV_REPO}`;

/** A minted, written invocation plus a live owner for it. The caller closes what it opens. */
async function invocation({ open = true } = {}) {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-owner-"));
  const context = buildInstanceContext({ profileRoot, invocation: randomUUID(), profileRef: "integrated" });
  const contextFile = writeInstanceContext(context);
  const owner = new HerdrOwner(context);
  if (open) await owner.listen();
  return { profileRoot, context, contextFile, owner };
}

test("the verdict accepts its own invocation and refuses everything else", () => {
  const mine = { invocation: "i", scope: "herdr-i" };
  const good = { version: 1, operation: "authorize-env", invocation: "i", scope: "herdr-i", nonce: "n" };
  assert.equal(challengeVerdict(good, mine), "accept");
  assert.equal(challengeVerdict({ ...good, operation: "probe-owner" }, mine), "accept");
  assert.equal(challengeVerdict({ ...good, version: 2 }, mine), "unsupported-version");
  assert.equal(challengeVerdict({ ...good, operation: "stop" }, mine), "unknown-operation");
  assert.equal(challengeVerdict({ ...good, nonce: "" }, mine), "missing-nonce");
  // A challenge naming somebody else's invocation must not be vouched for.
  assert.equal(challengeVerdict({ ...good, invocation: "other" }, mine), "not-mine");
  assert.equal(challengeVerdict({ ...good, scope: "herdr-other" }, mine), "not-mine");
  assert.equal(challengeVerdict(null, mine), "malformed");
  assert.equal(challengeVerdict([good], mine), "malformed");
});

test("an owner with no endpoint refuses to exist, rather than binding something arbitrary", () => {
  // `server.listen(undefined)` binds an arbitrary TCP port instead of failing, so an owner built
  // from a mis-spelled field once looked healthy while serving nothing the daemon could reach.
  assert.throws(() => new HerdrOwner({ invocation: "i", scope: "herdr-i" }), /ownerEndpoint required/);
  assert.throws(() => new HerdrOwner({ invocation: "i", scope: "herdr-i", ownerEndpoint: "" }), /ownerEndpoint required/);
  assert.throws(() => new HerdrOwner({ ownerEndpoint: "/tmp/owner.sock" }), /identity required/);
});

test("the reply echoes the challenge, because that is what the daemon checks", () => {
  const challenge = { version: 1, operation: "authorize-env", invocation: "i", scope: "herdr-i", nonce: "n" };
  assert.deepEqual(replyTo(challenge, "accept"), { ...challenge, accepted: true });
  assert.deepEqual(replyTo(challenge, "not-mine"), { ...challenge, accepted: false });
});

test("aify-env's REAL prepareInstance is admitted by a live owner", { skip: skipWithoutEnv }, async () => {
  const { context, contextFile, owner } = await invocation();
  try {
    const admitted = await envBootstrap.prepareInstance(contextFile, { AIFY_ADVERTISE: "0" });
    assert.equal(admitted.invocation, context.invocation);
    assert.equal(admitted.scope, context.scope);
    // The daemon's challenge reached this owner and was judged, rather than being answered by
    // something else that happened to be on the endpoint.
    assert.ok(owner.exchanges.some(e => e.operation === "authorize-env" && e.verdict === "accept"));
  } finally {
    await owner.close();
  }
});

test("with no owner listening, the daemon is refused", { skip: skipWithoutEnv }, async () => {
  const { contextFile, owner } = await invocation({ open: false });
  await assert.rejects(
    () => envBootstrap.prepareInstance(contextFile, { AIFY_ADVERTISE: "0" }),
    /owner authorization refused/,
  );
  await owner.close();
});

test("an owner that belongs to another invocation does not vouch for this daemon", { skip: skipWithoutEnv }, async () => {
  const { context, contextFile } = await invocation({ open: false });
  // Same endpoint, different identity — exactly what a stale owner from a previous launch looks
  // like if its pipe name were ever reused.
  const stranger = new HerdrOwner({ invocation: randomUUID(), scope: "herdr-stranger", ownerEndpoint: context.ownerEndpoint });
  await stranger.listen();
  try {
    await assert.rejects(
      () => envBootstrap.prepareInstance(contextFile, { AIFY_ADVERTISE: "0" }),
      /owner authorization refused/,
    );
    assert.ok(stranger.exchanges.some(e => e.verdict === "not-mine"), "the stranger never judged the challenge");
  } finally {
    await stranger.close();
  }
});

test("a service in the registry is refused before anything starts", { skip: skipWithoutEnv }, async () => {
  const { context, contextFile, owner } = await invocation();
  try {
    fs.writeFileSync(context.serviceRegistry, JSON.stringify({ version: 1, services: { "aify-comms": { url: "http://x" } } }));
    await assert.rejects(
      () => envBootstrap.prepareInstance(contextFile, { AIFY_ADVERTISE: "0" }),
      /scoped_service_contract_required/,
    );
  } finally {
    await owner.close();
  }
});

test("leaving advertisement on is refused, so a dedicated instance cannot publish itself", { skip: skipWithoutEnv }, async () => {
  const { contextFile, owner } = await invocation();
  try {
    await assert.rejects(() => envBootstrap.prepareInstance(contextFile, {}), /advertisement must be explicitly disabled/);
    await assert.rejects(() => envBootstrap.prepareInstance(contextFile, { AIFY_ADVERTISE: "1" }), /advertisement/);
  } finally {
    await owner.close();
  }
});

// ── One owner per profile ────────────────────────────────────────────────────────────────────────

test("a refusal is ANSWERED, not dropped", async () => {
  // Dropping a refusal is indistinguishable from a crashed owner: both leave the daemon waiting out
  // its two-second timeout and reporting `owner authorization refused`. So this reads the reply off
  // the socket rather than inferring it from how long the caller waited — a timing assertion would
  // be the flaky way to ask, and would pass on a fast machine either way.
  const { context, owner } = await invocation();
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(context.ownerEndpoint);
      let text = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("the owner never answered a refusal")); }, 4000);
      socket.on("error", reject);
      socket.on("connect", () => socket.write(`${JSON.stringify({ version: 1, operation: "authorize-env", invocation: "somebody-else", scope: "herdr-somebody-else", nonce: "n" })}\n`));
      socket.on("data", chunk => {
        text += chunk;
        if (!text.includes("\n")) return;
        clearTimeout(timer);
        socket.destroy();
        resolve(JSON.parse(text.split("\n")[0]));
      });
    });
    assert.equal(reply.accepted, false);
    assert.equal(reply.nonce, "n", "the refusal did not echo the challenge it refused");
  } finally {
    await owner.close();
  }
});

test("a yes-man that accepts without echoing the challenge is NOT a live owner", async () => {
  // THE CASE THE NONCE EXISTS FOR, and the one a wrong-identity owner cannot exercise: a listener
  // that answers `accepted: true` to anything. Without the echo check the probe believes it, and a
  // second launcher would then refuse to start because some unrelated pipe said yes.
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\aify-herdr-yesman-${randomUUID()}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-yesman-")), "s.sock");
  const server = net.createServer(socket => {
    socket.on("data", () => socket.end(`${JSON.stringify({ accepted: true })}\n`));
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  try {
    assert.equal(await probeOwner(endpoint, { invocation: randomUUID(), scope: "herdr-x" }, { timeoutMs: 1500 }), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("a probe proves liveness by the echoed nonce, not by something listening", async () => {
  const { context, owner } = await invocation();
  try {
    assert.equal(await probeOwner(context.ownerEndpoint, context), true);
    // Positive control for the probe's ability to say NO: same live owner, wrong identity.
    assert.equal(await probeOwner(context.ownerEndpoint, { invocation: randomUUID(), scope: "herdr-x" }), false);
  } finally {
    await owner.close();
  }
  assert.equal(await probeOwner(context.ownerEndpoint, context, { timeoutMs: 500 }), false);
});

test("a profile with no pointer, and one with an unreadable pointer, are free", async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-free-"));
  assert.deepEqual(await profileOwnerState(profileRoot), { owned: false, reason: "no-pointer" });
  fs.writeFileSync(profileOwnerFile(profileRoot), "{ not json");
  assert.deepEqual(await profileOwnerState(profileRoot), { owned: false, reason: "no-pointer" });
  fs.writeFileSync(profileOwnerFile(profileRoot), JSON.stringify({ version: 9 }));
  assert.deepEqual(await profileOwnerState(profileRoot), { owned: false, reason: "unreadable-pointer" });
});

test("a live owner makes the profile owned; killing it makes the pointer stale, not permanent", async () => {
  const { profileRoot, context, owner } = await invocation();
  writeProfileOwner(profileRoot, { invocation: context.invocation, ownerEndpoint: context.ownerEndpoint, pid: process.pid });

  const held = await profileOwnerState(profileRoot);
  assert.equal(held.owned, true);
  assert.equal(held.invocation, context.invocation);

  // Drive the control by removing the thing it watches: the pointer file is untouched, only the
  // owner goes away. A pointer that outlives its process must not lock the profile forever.
  await owner.close();
  const released = await profileOwnerState(profileRoot, { timeoutMs: 500 });
  assert.deepEqual(released, { owned: false, reason: "stale-pointer", invocation: context.invocation });
  assert.ok(fs.existsSync(profileOwnerFile(profileRoot)), "the stale pointer was deleted by a read");
});

test("a launcher that lost the race cannot release the winner's profile", async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-race-"));
  const winner = randomUUID();
  writeProfileOwner(profileRoot, { invocation: winner, ownerEndpoint: "\\\\.\\pipe\\x", pid: 1 });
  assert.equal(clearProfileOwner(profileRoot, randomUUID()), false, "a loser removed the winner's pointer");
  assert.ok(fs.existsSync(profileOwnerFile(profileRoot)));
  assert.equal(clearProfileOwner(profileRoot, winner), true);
  assert.equal(fs.existsSync(profileOwnerFile(profileRoot)), false);
});
