// The pure pieces of connect, each held to the rule it exists for.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { USAGE, keyFromText, parseConnectArgs } from "../lib/connect-args.mjs";
import { artifactStanding, mergeEntry, registryWith, renderServers, retiredRefs, stableJson } from "../lib/connect-entry.mjs";
import { NoSpec, REQUEST_TIMEOUT_MS, RedirectRefused, checkHealth, checkProbe, fetchServed, fetchSpec } from "../lib/connect-http.mjs";
import { Refused, aifyEnvTools, connect, fileSetDigest, stagedRef } from "../lib/connect.mjs";
import { SPEC_PATH, SPEC_VERSION, isCredentialRefField, resolveRoute, routeProblem, tupleDigest, validateSpec } from "../lib/service-spec.mjs";
import { FAKE_ENV, commsSpec, makeHost } from "./connect-fixture.mjs";

const target = { name: "aify-comms", endpoint: "http://h:1/comms" };

test("validateSpec accepts comms' frozen shape and refuses each door the spec might open", () => {
  const host = makeHost();
  const good = commsSpec(host);
  assert.deepEqual(validateSpec(good, target).errors, []);
  const refused = (spec, pattern) => {
    const judged = validateSpec(spec, target);
    assert.equal(judged.ok, false);
    assert.match(judged.errors.join("\n"), pattern);
  };
  refused({ ...good, specVersion: 2 }, /specVersion 2 is not supported/);
  refused({ ...good, specVersion: undefined }, /specVersion undefined/);
  refused({ ...good, extra: 1 }, /unknown field\(s\) extra/);
  refused({ ...good, fixed: { ...good.fixed, mcp: [] } }, /fixed\.mcp is derived/);
  refused({ ...good, fixed: { ...good.fixed, secretsCredentialRef: "x" } }, /fixed\.secretsCredentialRef names a credential/);
  refused({ ...good, artifacts: [{ ...good.artifacts[0], source: { pending: "later" } }] }, /pending and may not carry a sha256/);
  refused({ ...good, artifacts: [{ ...good.artifacts[0], source: { git: { repo: "a/b", revision: "main" } } }] }, /40-hex commit/);
  refused({ ...good, artifacts: [{ ...good.artifacts[0], entries: ["../escape.js"] }] }, /not a relative file path/);
  refused({ ...good, secrets: [{ field: "apiKey", required: true }] }, /credential reference field/);
  refused({ ...good, verify: { ...good.verify, probes: { api: { path: "/x" } } } }, /must be \{path, header\}/);
  refused({ ...good, verify: { ...good.verify, health: { path: "http://elsewhere/health" } } }, /not an absolute path/);
  assert.equal(validateSpec({ ...good, version: "anything" }, target).ok, true, "version is display-only");
});

test("the dashboard's live spec (1.3.10, read without a key) passes as the format owner froze it", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("./fixtures/aify-dashboard-spec-1.3.10.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSpec(spec, { name: "aify-dashboard", endpoint: "http://127.0.0.1:9700" }).errors, []);
  assert.equal(validateSpec(spec, { name: "aify-comms", endpoint: "http://127.0.0.1:9700" }).ok, false, "CONTROL: it is judged");
  assert.ok(new NoSpec("x") instanceof Error);
});

test("routes resolve origin-relative and a path is held to the registry's rule", () => {
  assert.equal(resolveRoute("http://h:1/comms/", "/api/v1/agents"), "http://h:1/api/v1/agents");
  assert.equal(routeProblem("/ok"), "");
  for (const bad of ["//h/x", "x", "/a b", "/a\\b"]) assert.notEqual(routeProblem(bad), "", bad);
  assert.equal(SPEC_PATH, "/.well-known/aify-service");
  assert.equal(SPEC_VERSION, 1);
  assert.ok(isCredentialRefField("credentialRef") && isCredentialRefField("secretsCredentialRef") && !isCredentialRefField("apiKey"));
});

test("an approval binds the exact tuple: any change to kind, source, hash or entries is a different digest", () => {
  const a = { id: "x", kind: "file-set", source: { git: { repo: "a/b", revision: "a".repeat(40) } }, sha256: "b".repeat(64), entries: ["s.js"] };
  assert.equal(tupleDigest(a), tupleDigest({ ...a, id: "renamed" }), "the id is not part of what runs");
  for (const change of [{ kind: "package" }, { sha256: "c".repeat(64) }, { entries: ["t.js"] }, { source: { git: { repo: "a/b", revision: "d".repeat(40) } } }]) {
    assert.notEqual(tupleDigest(a), tupleDigest({ ...a, ...change }));
  }
  const standing = artifactStanding([a, { id: "p", source: { pending: "why" } }], new Set([tupleDigest(a)]));
  assert.deepEqual(standing.map((s) => s.approved ?? s.pending), [true, "why"]);
});

test("servers render with the given absolute node and the install root; a pending one is reported, not written", () => {
  const spec = { mcp: [{ name: "s", artifact: "a", entry: "e.js" }, { name: "p", artifact: "b", entry: "bin" }] };
  const out = renderServers(spec, [{ id: "a", approved: true }, { id: "b", pending: "later" }],
    new Map([["a", { root: "/root", files: { "e.js": "e.js" } }]]), "/abs/node");
  assert.deepEqual(out.servers, [{ name: "s", command: "/abs/node", args: ["/root/e.js"] }]);
  assert.deepEqual(out.pending, [{ name: "p", reason: "later" }]);
});

test("mergeEntry keeps every field it does not set, and retiredRefs names what a new reference replaces", () => {
  const existing = { endpoint: "old", advertise: false, secretsCredentialRef: "s.key", credentialRef: "old.key", mcp: [{ name: "keep" }, { name: "s", command: "old" }] };
  const entry = mergeEntry(existing, { endpoint: "new", fixed: { agentState: { path: "/a" } }, servers: [{ name: "s", command: "n", args: [] }], refs: { credentialRef: "new.key" } });
  assert.equal(entry.advertise, false);
  assert.equal(entry.secretsCredentialRef, "s.key");
  assert.deepEqual(entry.mcp.map((s) => s.command ?? s.name), ["keep", "n"]);
  assert.deepEqual(retiredRefs(existing, { credentialRef: "new.key" }), [{ field: "credentialRef", ref: "old.key" }]);
  assert.deepEqual(retiredRefs(undefined, { credentialRef: "x" }), []);
});

test("registryWith refuses a registry it cannot read and writes the stable byte form otherwise", () => {
  assert.equal(registryWith("{not json", "s", {}).ok, false);
  assert.equal(registryWith("{\"version\":2,\"services\":{}}", "s", {}).ok, false);
  assert.equal(registryWith("", "s", { b: 1, a: [] }).text, "{\n  \"services\": {\n    \"s\": {\n      \"a\": [],\n      \"b\": 1\n    }\n  },\n  \"version\": 1\n}\n");
  assert.equal(stableJson({ z: 1, a: { y: 2, b: 3 } }), "{\n  \"a\": {\n    \"b\": 3,\n    \"y\": 2\n  },\n  \"z\": 1\n}");
});

test("arguments: a key is never an argument, two key sources are refused, and a url carrying credentials is refused", () => {
  assert.equal(parseConnectArgs(["s", "http://h"]).problem, "");
  assert.match(parseConnectArgs(["s", "http://h", "--token=x"]).problem, /argv/);
  assert.match(parseConnectArgs(["s", "http://h", "--key-file", "f", "--key-stdin"]).problem, /give one/);
  assert.match(parseConnectArgs(["s", "http://user:pw@h"]).problem, /without credentials/);
  assert.deepEqual(parseConnectArgs(["s", "http://h", "--secret-file", "secretsCredentialRef=f"]).secretFiles, { secretsCredentialRef: "f" });
  assert.equal(keyFromText("k\r\n"), "k");
  assert.equal(keyFromText("k \n"), "k ", "only the one line ending is removed");
  assert.match(USAGE, /--key-stdin/);
});

test("a staged reference is fresh and inside aify-env's grammar", () => {
  const a = stagedRef("aify-dashboard", "secretsCredentialRef");
  assert.notEqual(a, stagedRef("aify-dashboard", "secretsCredentialRef"));
  assert.match(a, /^[A-Za-z0-9._-]{1,64}$/);
  assert.ok(!a.startsWith("."));
});

test("fileSetDigest binds the entries' bytes and names, in a fixed order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-fileset-"));
  fs.writeFileSync(path.join(dir, "a.js"), "a");
  fs.writeFileSync(path.join(dir, "b.js"), "b");
  const digest = fileSetDigest(dir, ["a.js", "b.js"]);
  assert.equal(digest, fileSetDigest(dir, ["b.js", "a.js"]));
  fs.writeFileSync(path.join(dir, "b.js"), "B");
  assert.notEqual(digest, fileSetDigest(dir, ["a.js", "b.js"]));
});

test("aifyEnvTools runs aify-env's commands and turns a non-zero exit into a refusal naming the command", () => {
  const tools = aifyEnvTools(FAKE_ENV, { ...process.env, AIFY_TEST_FAIL: "registry-check" });
  assert.throws(() => tools.registryCheck("x"), (error) => error instanceof Refused && /aify-env registry check failed/.test(error.message));
  assert.equal(typeof connect, "function");
});

test("HTTP: no redirect is followed, a probe sends the real key last, and served bytes are checked against their hash", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers["x-k"] ?? "-"}`);
    if (req.url === "/.well-known/aify-service") return res.writeHead(301, { location: "http://elsewhere/" }).end();
    if (req.url === "/health") return res.writeHead(200).end();
    if (req.url === "/t.tgz") return res.writeHead(req.headers["x-k"] === "KEY" ? 200 : 401).end("bytes");
    return res.writeHead(req.headers["x-k"] === "KEY" ? 200 : 401).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(fetchSpec(url), RedirectRefused);
    await checkHealth(url, { verify: { health: { path: "/health" } } });
    await checkProbe(url, { path: "/p", header: "x-k" }, "KEY");
    assert.deepEqual(seen.filter((s) => s.startsWith("/p")).map((s) => s.split(" ")[1] === "KEY"), [false, false, true]);
    const { createHash } = await import("node:crypto");
    const artifact = { id: "t", sha256: createHash("sha256").update("bytes").digest("hex"), source: { served: { path: "/t.tgz", version: "1" } } };
    assert.equal((await fetchServed(url, artifact, "x-k", "KEY")).toString(), "bytes");
    await assert.rejects(fetchServed(url, { ...artifact, sha256: "0".repeat(64) }, "x-k", "KEY"), /not the spec's/);
    assert.ok(REQUEST_TIMEOUT_MS > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
