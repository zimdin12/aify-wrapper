#!/usr/bin/env node
// The service registry, proven by parsing it rather than by trusting its shape.
//
// `~/.aify/services.json` is written by each service's installer and read by this package at INSTALL
// time. It is the only place a launcher learns that a service exists, so everything that can go wrong
// with it goes wrong silently: a missing file looks like a host with no services, a malformed file
// looks like a host with no services, and a service that forgot to declare which environment names
// carry its endpoint looks like a service whose endpoint simply did not arrive.
//
// The last of those is the one worth stating, because it is a measurement rather than a guess. A
// runtime's per-server MCP env block is KEY-SCOPED — proven on Claude Code 2.1.236, where a per-server
// AIFY_SERVER_URL beat an inherited value while an inherited AIFY_COMMS_URL survived untouched. So a
// service reading a name the block does not set inherits it from whatever launched the runtime. Which
// name carries an endpoint is the service's business, and the registry makes it say so.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRegistry, endpointFor, mcpEntriesFor, fingerprint } from "../lib/registry.mjs";

const json = (o) => JSON.stringify(o);

const ONE_SERVICE = {
  version: 1,
  services: {
    "aify-comms": {
      endpoint: "http://127.0.0.1:8800",
      endpointEnv: ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"],
      mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }],
    },
  },
};

test("a service declaring endpointEnv gets those keys populated with its endpoint", () => {
  const { ok, registry } = parseRegistry(json(ONE_SERVICE));
  assert.equal(ok, true);
  assert.deepEqual(mcpEntriesFor(registry)[0].env, {
    AIFY_SERVER_URL: "http://127.0.0.1:8800",
    CLAUDE_MCP_SERVER_URL: "http://127.0.0.1:8800",
  });
});

test("a service that declares no endpointEnv gets an EMPTY env, not a guessed one", () => {
  // Guessing AIFY_SERVER_URL would work silently for aify-comms and fail silently for every other
  // service, which is the worst of both: the bug never appears where it was introduced.
  const { registry } = parseRegistry(json({
    version: 1,
    services: { graph: { endpoint: "http://x", mcp: [{ name: "g", command: "node", args: [] }] } },
  }));
  assert.deepEqual(mcpEntriesFor(registry)[0].env, {});
});

test("malformed JSON reports an error and never throws", () => {
  const r = parseRegistry("{not json");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0, "a refusal must say why");
});

test("an unknown top-level version is refused rather than best-guessed", () => {
  const r = parseRegistry(json({ version: 99, services: {} }));
  assert.equal(r.ok, false);
});

test("a refused registry carries NO registry object at all", () => {
  // Fail closed. A half-populated registry is how a caller ends up installing against one service
  // because the second one failed validation quietly.
  for (const bad of ["{not json", json({ version: 99, services: {} }), json({ version: 1 })]) {
    assert.equal(parseRegistry(bad).registry, undefined);
  }
});

test("fingerprint is stable across key order and changes when an endpoint changes", () => {
  const a = parseRegistry('{"version":1,"services":{"a":{"endpoint":"u","mcp":[]},"b":{"endpoint":"v","mcp":[]}}}').registry;
  const b = parseRegistry('{"version":1,"services":{"b":{"endpoint":"v","mcp":[]},"a":{"endpoint":"u","mcp":[]}}}').registry;
  const c = parseRegistry('{"version":1,"services":{"a":{"endpoint":"CHANGED","mcp":[]},"b":{"endpoint":"v","mcp":[]}}}').registry;
  assert.equal(fingerprint(a), fingerprint(b), "key order is not a change");
  assert.notEqual(fingerprint(a), fingerprint(c), "an endpoint change must be a change");
});

test("fingerprint changes when a service is ADDED, which is the case it exists for", () => {
  const one = parseRegistry(json(ONE_SERVICE)).registry;
  const two = parseRegistry(json({
    version: 1,
    services: { ...ONE_SERVICE.services, graph: { endpoint: "http://g", mcp: [] } },
  })).registry;
  assert.notEqual(fingerprint(one), fingerprint(two));
});

test("a MISSING registry is a valid EMPTY registry, not an error", () => {
  // A host with no service installed is a legitimate state: the launchers still install.
  for (const absent of ["", "   ", null, undefined]) {
    const r = parseRegistry(absent);
    assert.equal(r.ok, true, `absent registry (${JSON.stringify(absent)}) must be ok`);
    assert.deepEqual(r.registry.services, {});
    assert.deepEqual(mcpEntriesFor(r.registry), []);
  }
});

test("two services claiming the same MCP server name are REFUSED", () => {
  // mcpServers is a map. A duplicate name does not error anywhere downstream, it silently drops one
  // service — and the dropped one is whichever the writer happened to emit first.
  const r = parseRegistry(json({
    version: 1,
    services: {
      "aify-comms": { endpoint: "http://a", mcp: [{ name: "shared", command: "node", args: [] }] },
      graph: { endpoint: "http://b", mcp: [{ name: "shared", command: "node", args: [] }] },
    },
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(" ").includes("shared"), "the refusal must name the colliding entry");
});

test("an mcp entry with no command is refused", () => {
  const r = parseRegistry(json({
    version: 1,
    services: { graph: { endpoint: "http://b", mcp: [{ name: "g", args: [] }] } },
  }));
  assert.equal(r.ok, false);
});

test("endpointFor answers for a known service and returns null for an unknown one", () => {
  const { registry } = parseRegistry(json(ONE_SERVICE));
  assert.equal(endpointFor(registry, "aify-comms"), "http://127.0.0.1:8800");
  assert.equal(endpointFor(registry, "not-installed"), null);
});

test("mcpEntriesFor is ordered deterministically, so a rendered config is reproducible", () => {
  // Two installs from one registry must produce byte-identical output, or every reinstall looks like
  // a change to anything comparing wrappers.
  const built = (services) => mcpEntriesFor(parseRegistry(json({ version: 1, services })).registry)
    .map((e) => e.name);
  const forward = built({
    a: { endpoint: "u", mcp: [{ name: "a1", command: "node", args: [] }] },
    b: { endpoint: "v", mcp: [{ name: "b1", command: "node", args: [] }] },
  });
  const reversed = built({
    b: { endpoint: "v", mcp: [{ name: "b1", command: "node", args: [] }] },
    a: { endpoint: "u", mcp: [{ name: "a1", command: "node", args: [] }] },
  });
  assert.deepEqual(forward, reversed);
});
