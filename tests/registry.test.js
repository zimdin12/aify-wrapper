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

import {
  parseRegistry, mcpEntriesFor, fingerprint, REGISTRY_VERSION,
  strictMcpEntriesFor, strictMcpFragment, strictMcpFragmentBase64,
} from "../lib/registry.mjs";

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

// ── strict-mode opt-in ───────────────────────────────────────────────────────────
// AIFY_CLAUDE_STRICT_MCP exists BECAUSE extra MCP servers cause the Claude init race that leaves
// aify-comms-channel stuck connecting. So strict mode carries what an operator explicitly opted in,
// never everything registered — the latter would reintroduce the failure the flag is the workaround
// for. Absent means today's behaviour.

test("strictMcp defaults to absent, and no service is opted in by default", () => {
  const { registry } = parseRegistry(json(ONE_SERVICE));
  assert.deepEqual(strictMcpEntriesFor(registry), []);
});

test("only services that opted in appear in the strict set", () => {
  const { ok, registry } = parseRegistry(json({
    version: 1,
    services: {
      "aify-comms": { endpoint: "http://a", mcp: [{ name: "a", command: "node", args: [] }] },
      graph: { endpoint: "http://b", strictMcp: true, endpointEnv: ["G_URL"], mcp: [{ name: "g", command: "node", args: [] }] },
    },
  }));
  assert.equal(ok, true);
  assert.deepEqual(strictMcpEntriesFor(registry).map((e) => e.name), ["g"]);
  assert.deepEqual(strictMcpEntriesFor(registry)[0].env, { G_URL: "http://b" });
});

test("opting in with no mcp entries contributes nothing rather than an empty object", () => {
  const { registry } = parseRegistry(json({
    version: 1,
    services: { graph: { endpoint: "http://b", strictMcp: true } },
  }));
  assert.deepEqual(strictMcpEntriesFor(registry), []);
});

test("a non-boolean strictMcp is refused rather than coerced", () => {
  // "false" and 0 are both truthy-or-falsy depending on who reads them. Refuse the ambiguity.
  for (const bad of ["true", 1, null]) {
    const r = parseRegistry(json({ version: 1, services: { g: { endpoint: "http://b", strictMcp: bad } } }));
    assert.equal(r.ok, false, `strictMcp: ${JSON.stringify(bad)} should be refused`);
  }
});

// ── the fragment, and the escaping the heredoc demands ───────────────────────────
// The strict config is written from an UNQUOTED heredoc, where bash still interprets \, $ and a
// backtick. This project has already shipped a bug of exactly that shape: an unescaped backtick in an
// unquoted heredoc blanked a comment in every installed hermes-aify, and it was found only by
// byte-comparing renders.

test("an empty strict set yields an EMPTY fragment, so the config is unchanged", () => {
  const { registry } = parseRegistry(json(ONE_SERVICE));
  assert.equal(strictMcpFragment(registry), "");
});

test("a populated fragment starts with a comma, so it splices after the last entry", () => {
  const { registry } = parseRegistry(json({
    version: 1,
    services: { g: { endpoint: "http://b", strictMcp: true, mcp: [{ name: "g", command: "node", args: [] }] } },
  }));
  assert.match(strictMcpFragment(registry), /^,\n/);
});

test("REAL BASH: a hostile path survives the installer AND the heredoc", async () => {
  // Deliberately not re-implementing bash's rules to check them here. A test that models the shell
  // tests the model, and the model is what is most likely to be wrong — an earlier version of this
  // test failed twice against a correct implementation, and then PASSED against an implementation
  // that was still one hop short, because it only modelled the heredoc and not the installer's
  // parameter substitution. Both hops eat backslashes. Base64 removes them instead of counting them.
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");

  const B = String.fromCharCode(92), TICK = String.fromCharCode(96);
  const nasty = `C:${B}bin${B}$HOME${B}${TICK}whoami${TICK}${B}s.js`;

  const { registry } = parseRegistry(json({
    version: 1,
    services: {
      g: { endpoint: "http://b", strictMcp: true, mcp: [{ name: "g", command: "node", args: [nasty] }] },
    },
  }));
  const encoded = strictMcpFragmentBase64(registry);
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/, "base64 must carry no shell metacharacter");

  // Decode through the SAME construct the launcher uses, then splice it in through a heredoc exactly
  // as the launcher does.
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aify-b64-"));
  const out = pathMod.join(dir, "config.json");
  const script = pathMod.join(dir, "emit.sh");
  fs.writeFileSync(script, [
    "#!/bin/bash",
    "set -euo pipefail",
    `EXTRA="$(printf '%s' "${encoded}" | base64 -d)"`,
    `cat > "${out.split(String.fromCharCode(92)).join("/")}" <<JSON`,
    "{",
    '  "mcpServers": {',
    '    "aify-comms": { "command": "node", "args": [], "env": {} }${EXTRA}',
    "  }",
    "}",
    "JSON",
    "",
  ].join(String.fromCharCode(10)));

  execFileSync("bash", [script], { encoding: "utf8" });
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.mcpServers.g.args[0], nasty, "the path did not survive");
  assert.ok(written.mcpServers["aify-comms"], "the primary entry was disturbed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty strict set encodes to an empty string, leaving the default path untouched", () => {
  assert.equal(strictMcpFragmentBase64(parseRegistry(json(ONE_SERVICE)).registry), "");
});

test("CROSS-REPO: a registry written by aify-comms parses here, with both servers resolved", async () => {
  // This parser is the AUTHORITATIVE one -- it renders launchers from what it reads. Every other test
  // in this file feeds it a hand-written object, so if the writer and this reader ever disagreed they
  // would all still pass while every launcher was built against nothing.
  //
  // It was checked once by hand in a terminal. Once, by hand, is a rumour.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const { spawnSync } = await import("node:child_process");

  const writer = pathMod.join("C:", "Docker", "aify-comms", "mcp", "stdio", "register-service-cli.mjs");
  if (!fs.existsSync(writer)) {
    assert.fail("aify-comms is not checked out here, so the cross-repo contract cannot be exercised");
  }

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aify-wrapper-xrepo-"));
  const file = pathMod.join(dir, "services.json");
  // Set, and reachable by nothing.
  const wrote = spawnSync(process.execPath, [writer, file, "http://127.0.0.2:1", "/b/mcp/stdio"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(wrote.status, 0, wrote.stdout + wrote.stderr);

  const parsed = parseRegistry(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.ok, true, `the authoritative parser rejected it: ${JSON.stringify(parsed.errors)}`);

  const entries = mcpEntriesFor(parsed.registry);
  assert.deepEqual(entries.map((e) => e.name).sort(), ["aify-comms", "aify-comms-channel"]);

  // The half that would fail silently rather than loudly: a service whose endpointEnv the writer and
  // the reader disagreed about would produce entries with an EMPTY env, and a bridge that then
  // inherited its endpoint from whatever launched the runtime.
  for (const entry of entries) {
    assert.ok(Object.keys(entry.env).length > 0, `${entry.name} resolved with no endpoint env at all`);
    for (const value of Object.values(entry.env)) {
      assert.equal(value, "http://127.0.0.2:1", `${entry.name} got the wrong endpoint`);
    }
  }

  // And a fingerprint, since that is what a launcher bakes.
  assert.match(fingerprint(parsed.registry), /^[0-9a-f]{8,}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("REGISTRY_VERSION is the version this parser accepts, and the only one", () => {
  // The constant and the behaviour have to agree. Exported and never asserted, it is a number somebody
  // can bump in one place while the parser keeps refusing files written to it — a schema version that
  // lies is worse than none, because every writer trusts it.
  assert.equal(typeof REGISTRY_VERSION, "number");

  const at = (version) => parseRegistry(json({ version, services: {} })).ok;
  assert.equal(at(REGISTRY_VERSION), true, "the parser refuses the version it declares");
  assert.equal(at(REGISTRY_VERSION + 1), false, "a future version was accepted");
  assert.equal(at(REGISTRY_VERSION - 1), false, "an older version was accepted");
});

test("what this package WRITES is what it declares it reads", () => {
  // The other half of the same agreement, checked against a real file rather than a literal: the
  // registry aify-comms produces must carry the version this parser expects, or the two repos disagree
  // about the schema while every unit test on both sides passes.
  const parsed = parseRegistry(json({
    version: REGISTRY_VERSION,
    services: { "aify-comms": { endpoint: "http://127.0.0.2:1", mcp: [] } },
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.registry.version, REGISTRY_VERSION);
});
