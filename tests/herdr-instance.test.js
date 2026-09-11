#!/usr/bin/env node
// The context this repo mints must be one aify-env accepts — proven against aify-env's real reader.
//
// THIS IS THE SEAM THAT BREAKS SILENTLY. `readInstanceContext` rejects an unexpected field count, a
// root whose parent is not named `invocations`, a private file at the wrong name, and the wrong
// platform spelling of an endpoint. Every one of those is a mistake a launcher can make while
// looking completely correct here, and each surfaces as the daemon refusing to start with a reason
// that names the context rather than the launcher. So this asserts the agreement itself: the exact
// object we write, read back by the exact function that judges it.
//
// AND IT CARRIES ITS OWN NEGATIVE CONTROL. An agreement test that only ever feeds the reader a good
// context cannot tell a strict reader from one that accepts anything — so each refusal below is
// driven by REMOVING or changing exactly the thing the reader is supposed to be watching, and the
// test fails if the reader shrugs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  CONTEXT_VERSION,
  EMPTY_SERVICE_REGISTRY,
  buildInstanceContext,
  dedicatedDaemonEnv,
  instancePaths,
  writeInstanceContext,
} from "../lib/herdr-instance.mjs";

const ENV_REPO = process.env.AIFY_ENV_REPO || path.join(os.homedir(), "projects", "aify-env");

/** A fresh profile root per test, under the run's own temp root. */
function profile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-profile-"));
}

function minted({ platform = process.platform } = {}) {
  const profileRoot = profile();
  const invocation = randomUUID();
  const context = buildInstanceContext({ profileRoot, invocation, profileRef: "integrated", platform });
  // The reader locates the context file by rule, so the test derives it by the same rule
  // rather than reading a field back off the object under test.
  const contextFile = path.join(context.root, "instance.json");
  return { profileRoot, invocation, context, contextFile };
}

test("the layout is derived from the invocation, not configured", () => {
  const invocation = randomUUID();
  const paths = instancePaths({ profileRoot: "/srv/p", invocation, platform: "linux" });
  assert.equal(path.basename(paths.root), invocation);
  assert.equal(path.basename(path.dirname(paths.root)), "invocations");
  assert.equal(paths.contextFile, path.join(paths.root, "instance.json"));
  assert.equal(paths.processRecord, path.join(paths.root, "owned-processes.json"));
  assert.equal(paths.serviceRegistry, path.join(paths.root, "services.json"));
  assert.equal(paths.readinessEndpoint, path.join(paths.root, "ready.json"));
  assert.equal(paths.ownerEndpoint, path.join(paths.root, "owner.sock"));
  assert.equal(paths.herdrApiEndpoint, path.join(paths.root, "herdr.sock"));
});

test("windows endpoints are named pipes, and the names carry the invocation", () => {
  const invocation = randomUUID();
  const paths = instancePaths({ profileRoot: "C:/p", invocation, platform: "win32" });
  assert.equal(paths.ownerEndpoint, `\\\\.\\pipe\\aify-herdr-owner-${invocation}`);
  assert.equal(paths.herdrApiEndpoint, `\\\\.\\pipe\\aify-herdr-api-${invocation}`);
});

test("an invocation that is not a v4 uuid, and a relative root, are refused", () => {
  assert.throws(() => instancePaths({ profileRoot: "/p", invocation: "not-a-uuid" }), /v4 uuid/);
  assert.throws(() => instancePaths({ profileRoot: "relative/p", invocation: randomUUID() }), /absolute/);
  assert.throws(
    () => buildInstanceContext({ profileRoot: "/p", invocation: randomUUID(), profileRef: "has space" }),
    /profileRef/,
  );
});

test("the policy fields are constants: a dedicated instance never takes over and never recovers", () => {
  const { context } = minted();
  assert.equal(context.version, CONTEXT_VERSION);
  assert.equal(context.takeover, "refuse");
  assert.equal(context.recovery, "none");
  assert.equal(context.scope, `herdr-${context.invocation}`);
  assert.ok(Object.isFrozen(context));
});

test("writing a context creates the two files the daemon reads, and NONE of the three it publishes", () => {
  const { context, contextFile } = minted();
  const file = writeInstanceContext(context);
  assert.equal(file, contextFile);
  // Positive: the two that must exist.
  assert.ok(fs.existsSync(contextFile), "instance.json was not written");
  assert.deepEqual(JSON.parse(fs.readFileSync(context.serviceRegistry, "utf8")), EMPTY_SERVICE_REGISTRY);
  // Negative: the three whose prior existence means "this invocation is already used". If the
  // launcher ever pre-created one, every launch would be refused as a reused invocation.
  for (const name of ["owned-processes.json", "ready.json", "claimed.json"]) {
    assert.equal(fs.existsSync(path.join(context.root, name)), false, `${name} must be the daemon's to publish`);
  }
});

test("an invocation directory cannot be minted twice", () => {
  const { context } = minted();
  writeInstanceContext(context);
  assert.throws(() => writeInstanceContext(context), /EEXIST/);
});

test("the daemon environment disables advertisement, and leaves the agent's own profile alone", () => {
  const { context } = minted();
  const base = { PATH: "/usr/bin", HOME: "/home/steven", APPDATA: "C:/Users/x/AppData/Roaming" };
  const env = dedicatedDaemonEnv(base, context);
  assert.equal(env.AIFY_ADVERTISE, "0");
  assert.equal(env.AIFY_HERDR_INVOCATION, context.invocation);
  // Redirecting these would reach every shell, wrapper and agent started under this Herdr.
  assert.equal(env.HOME, base.HOME);
  assert.equal(env.APPDATA, base.APPDATA);
});

// ── The agreement, against aify-env's real reader ────────────────────────────────────────────────

const envReader = await (async () => {
  const file = path.join(ENV_REPO, "lib", "instance-context.mjs");
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
})();

test("aify-env's REAL reader accepts the context this repo mints", { skip: envReader ? false : `no aify-env checkout at ${ENV_REPO}` }, () => {
  const { context, contextFile } = minted();
  writeInstanceContext(context);
  const read = envReader.readInstanceContext(contextFile);
  assert.deepEqual({ ...read }, { ...context }, "the daemon read back something other than what we wrote");
});

test("and refuses each thing it is supposed to be watching", { skip: envReader ? false : `no aify-env checkout at ${ENV_REPO}` }, () => {
  const refusals = {
    // Drive each control by breaking exactly what it guards.
    "an extra field": c => ({ ...c, extra: 1 }),
    "a missing field": c => { const { profileRef, ...rest } = c; return rest; },
    "a future version": c => ({ ...c, version: 2 }),
    "a scope that does not match the invocation": c => ({ ...c, scope: "herdr-somebody-else" }),
    "takeover that is not a refusal": c => ({ ...c, takeover: "allow" }),
    "recovery that is not none": c => ({ ...c, recovery: "restore" }),
    "a shared process record": c => ({ ...c, processRecord: path.join(c.root, "..", "..", "env-processes.json") }),
    "an endpoint this platform does not spell that way": c => ({ ...c, ownerEndpoint: "/tmp/somebody-elses.sock" }),
  };
  for (const [what, break_] of Object.entries(refusals)) {
    const { context, contextFile } = minted();
    fs.mkdirSync(context.root, { recursive: true });
    fs.writeFileSync(context.serviceRegistry, JSON.stringify(EMPTY_SERVICE_REGISTRY));
    fs.writeFileSync(contextFile, JSON.stringify(break_(context)));
    assert.throws(
      () => envReader.readInstanceContext(contextFile),
      /instance_context:/,
      `the daemon accepted ${what}`,
    );
  }
});

test("an invocation the daemon has already used cannot be handed back to it", { skip: envReader ? false : `no aify-env checkout at ${ENV_REPO}` }, () => {
  const { context, contextFile } = minted();
  writeInstanceContext(context);
  // Positive control first: this exact context is good right now.
  assert.ok(envReader.readInstanceContext(contextFile));
  // A readiness receipt is what the daemon publishes when it boots. Its presence is how a second
  // boot in the same invocation is refused — the no-resurrection rule, enforced by the filesystem.
  fs.writeFileSync(context.readinessEndpoint, "{}\n");
  assert.throws(() => envReader.readInstanceContext(contextFile), /already used/);
});
