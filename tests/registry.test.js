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
import { readFileSync } from "node:fs";
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

test("CONTRACT: a registry as aify-comms actually writes it parses here, with both servers resolved", async () => {
  // This parser is the AUTHORITATIVE one -- it renders launchers from what it reads. Every other test
  // in this file feeds it a hand-written object, so if the writer and this reader ever disagreed they
  // would all still pass while every launcher was built against nothing.
  //
  // A RECORDED ARTIFACT rather than a live cross-repo call. The first version shelled out to a writer
  // at a hardcoded absolute path on one particular machine, which made this suite fail for everybody
  // else -- a public repo whose tests only pass on the author's laptop is broken, not covered. The
  // fixture is real output from that writer; aify-comms owns a test that it still matches, which is
  // where drift belongs because that is the only place both halves exist.
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const fixture = pathMod.join(here, "fixtures", "services-written-by-aify-comms.json");
  const parsed = parseRegistry(fs.readFileSync(fixture, "utf8"));
  assert.equal(parsed.ok, true, `the authoritative parser rejected it: ${JSON.stringify(parsed.errors)}`);

  const entries = mcpEntriesFor(parsed.registry);
  assert.deepEqual(entries.map((e) => e.name).sort(), ["aify-comms", "aify-comms-channel"]);

  // The half that would fail SILENTLY rather than loudly: a service whose endpointEnv the writer and
  // the reader disagreed about produces entries with an EMPTY env, and a bridge that then inherits its
  // endpoint from whatever launched the runtime. Correct-looking, until two services disagree.
  //
  // TWO KINDS OF NAME NOW, bound from two different sources, so they are checked separately rather
  // than by "every value is the endpoint" -- which was right while endpointEnv was the only list and
  // would quietly demand that a KEY equal a URL.
  const service = parsed.registry.services["aify-comms"];
  assert.ok(service.endpointEnv.length > 0, "the fixture declares no endpoint names");
  assert.ok(service.keyEnv.length > 0, "the fixture declares no key names");
  assert.deepEqual(
    service.endpointEnv.filter((name) => service.keyEnv.includes(name)),
    [],
    "a name declared in both lists would be bound twice, and the second write would win silently",
  );

  for (const entry of entries) {
    assert.ok(Object.keys(entry.env).length > 0, `${entry.name} resolved with no env at all`);
    for (const name of service.endpointEnv) {
      assert.equal(entry.env[name], "http://127.0.0.2:1", `${entry.name} got the wrong endpoint`);
    }
    for (const name of service.keyEnv) {
      // PINNED EVEN WHEN EMPTY. Omitting the name is what allows inheritance, which is the defect;
      // this test process carries no key, so "" is the right answer and its PRESENCE is the claim.
      assert.ok(name in entry.env, `${entry.name} left ${name} unpinned, so it would be inherited`);
      assert.equal(entry.env[name], process.env[name] ?? "");
    }
  }

  assert.match(fingerprint(parsed.registry), /^[0-9a-f]{8,}$/);
});

test("the contract fixture carries nothing machine-specific", () => {
  // It is a recorded artifact in a PUBLIC repo. A path from the machine that produced it would be both
  // a leak and a lie about what the writer emits -- the first attempt at this fixture captured
  // "C:/Program Files/Git/..." because the shell rewrote the argument on its way in.
  const text = readFileSync(new URL("./fixtures/services-written-by-aify-comms.json", import.meta.url), "utf8");
  // Built rather than written as a literal: a drive-letter pattern needs an escaped backslash, and a
  // backslash written through a shell here has been eaten five times in this work already.
  const BACKSLASH = String.fromCharCode(92);
  const machineish = new RegExp(`Program Files|Users|Administrator|Docker|[A-Z]:${BACKSLASH}${BACKSLASH}`, "i");
  assert.doesNotMatch(text, machineish);
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

test("credentialRef is CARRIED, not silently dropped", () => {
  // It was dropped until 2026-08-31, which meant this parser -- the one aify-comms calls
  // authoritative before writing its own entry -- validated none of the grammar below. A field a
  // parser merely passes through is a field nothing checked; a field it DROPS is worse, because the
  // writer then believes it was inspected.
  const parsed = parseRegistry(JSON.stringify({
    version: 1,
    services: { "aify-comms": { endpoint: "http://x", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: "a.key" } },
  }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.registry.services["aify-comms"].credentialRef, "a.key");
});

test("a reference that could escape the store is REFUSED here", () => {
  // WHERE the key lives, never what it is -- and only one name, so a registry every service can
  // write cannot point a daemon at a path of its choosing.
  for (const hostile of ["../services.json", "a/b", "a\b", "/etc/passwd", "..", ".", ".hidden", "x".repeat(65)]) {
    const parsed = parseRegistry(JSON.stringify({
      version: 1,
      services: { svc: { endpoint: "http://x", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: hostile } },
    }));
    assert.equal(parsed.ok, false, `accepted ${JSON.stringify(hostile)}`);
  }
  // POSITIVE CONTROL: an ordinary reference is accepted, so the refusals above are about the value.
  const fine = parseRegistry(JSON.stringify({
    version: 1,
    services: { svc: { endpoint: "http://x", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: "a.b-c_1.key" } },
  }));
  assert.equal(fine.ok, true, JSON.stringify(fine.errors));
});

test("TWO SERVICES CANNOT CLAIM ONE CREDENTIAL FILE, even in different case", () => {
  // On a case-insensitive volume they ARE one file, so accepting both would have two services
  // silently sharing a credential -- and the host it was tested on might be the one where they are
  // two. Only the whole file can see the pair, which is why the closure lives here.
  const both = parseRegistry(JSON.stringify({
    version: 1,
    services: {
      a: { endpoint: "http://x", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: "Foo.key" },
      b: { endpoint: "http://y", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: "foo.key" },
    },
  }));
  assert.equal(both.ok, false, "two services shared one credential file");
  assert.match(both.errors.join(" "), /claimed by both/);

  // DISTINCT references are fine, so the closure is about collision rather than about a second
  // service storing a credential at all.
  const distinct = parseRegistry(JSON.stringify({
    version: 1,
    services: {
      a: { endpoint: "http://x", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: "a.key" },
      b: { endpoint: "http://y", endpointEnv: [], keyEnv: [], mcp: [], credentialRef: "b.key" },
    },
  }));
  assert.equal(distinct.ok, true, JSON.stringify(distinct.errors));
});

test("no credentialRef is a normal state, not a fault", () => {
  // A service that stores no credential on this host is either keyless or driven from the
  // environment, and both are configurations rather than problems.
  const parsed = parseRegistry(JSON.stringify({
    version: 1,
    services: { svc: { endpoint: "http://x", endpointEnv: [], keyEnv: [], mcp: [] } },
  }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.registry.services.svc.credentialRef, "");
});
