#!/usr/bin/env node
// What a dedicated instance can SEE: the services this machine has.
//
// THE DEFECT THIS EXISTS FOR, read off the operator's own screen while the feature was "working":
//
//   SERVICES      no services registered on this host
//   FAIL  agent-picker  picker unavailable (HTTP 503): no service plugin on this host can start agents
//   FAIL  claiming      no service plugin is running, so nothing here claims work
//   FAIL  credentials   1 stored credential(s) that no registry entry references
//
// Every invocation was minted with a registry that was empty BY CONSTRUCTION, so the dedicated
// aify-env could locate no service, load no plugin, and start nothing -- the one thing the instance
// exists to do. All three of those rows are one cause: `credentialOrphans` compares the shared
// credential store against registry entries, so an empty registry makes every stored key an orphan.
//
// THE CREDENTIAL ROW WAS THE TELL. The credential STORE was already shared with the host while the
// registry was private, so the isolation was not even self-consistent.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EMPTY_SERVICE_REGISTRY, defaultHostRegistry, serviceRegistryFor } from "../lib/herdr-instance.mjs";

function hostRegistry(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-host-reg-")), "services.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

test("THE FIX: an instance sees what this host has", () => {
  const seeded = serviceRegistryFor({
    hostRegistry: hostRegistry({ services: {
      "aify-comms": { endpoint: "http://127.0.0.1:8800", credentialRef: "aify-comms-abc.key" },
      "aify-other": { endpoint: "http://127.0.0.1:9000" },
    } }),
  });
  assert.deepEqual(Object.keys(seeded.services).sort(), ["aify-comms", "aify-other"]);
  // The credential reference travels with the entry — without it every stored key reads as an orphan.
  assert.equal(seeded.services["aify-comms"].credentialRef, "aify-comms-abc.key");
  assert.equal(seeded.version, 1, "the daemon accepts version 1 only");
});

test("a host with nothing to copy still yields a registry the daemon admits", () => {
  assert.deepEqual(serviceRegistryFor({ hostRegistry: path.join(os.tmpdir(), "absent.json") }), EMPTY_SERVICE_REGISTRY);
  assert.deepEqual(serviceRegistryFor({}), EMPTY_SERVICE_REGISTRY);
});

test("a damaged or wrong-shaped host registry is refused, never half-read", () => {
  for (const contents of ["{ not json", JSON.stringify({ services: null }), JSON.stringify({ services: [] }), JSON.stringify({})]) {
    assert.deepEqual(
      serviceRegistryFor({ hostRegistry: hostRegistry(contents) }),
      EMPTY_SERVICE_REGISTRY,
      `a registry of ${contents.slice(0, 20)} produced a partial one`,
    );
  }
});

test("the host registry path is the one both tiers already use", () => {
  assert.equal(defaultHostRegistry({ home: path.join("C:", "someone") }), path.join("C:", "someone", ".aify", "services.json"));
  assert.ok(defaultHostRegistry().endsWith(path.join(".aify", "services.json")));
});
