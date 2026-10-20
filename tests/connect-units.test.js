// The pure pieces of connect, each held to the rule it exists for.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { USAGE, keyFromText, parseConnectArgs } from "../lib/connect-args.mjs";
import { artifactStanding, mergeEntry, registryWith, renderServers, retiredRefs, stableJson } from "../lib/connect-entry.mjs";
import { NoSpec, REQUEST_TIMEOUT_MS, RedirectRefused, checkHealth, checkProbe, fetchManifest, fetchServed, fetchSpec } from "../lib/connect-http.mjs";
import { Refused, aifyEnvTools, checkFileSet, connect, stagedRef } from "../lib/connect.mjs";
import { SPEC_PATH, SPEC_VERSION, isCredentialRefField, parseManifest, resolveRoute, routeProblem, tupleDigest, validateSpec } from "../lib/service-spec.mjs";
import { binFiles, installArgs, installedCommit } from "../lib/package-install.mjs";
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
  refused({ ...good, artifacts: [{ ...good.artifacts[0], manifest: undefined }] }, /manifest \{path\} is required for a file-set/);
  refused({ ...good, artifacts: [{ ...good.artifacts[0], manifest: { path: "//elsewhere/m" } }] }, /manifest\.path/);
  refused({ ...good, artifacts: [{ ...good.artifacts[0], source: { git: { repo: "a/b", revision: "main" } } }] }, /40-hex commit/);
  refused({ ...good, artifacts: [{ ...good.artifacts[0], entries: ["../escape.js"] }] }, /not a relative file path/);
  refused({ ...good, secrets: [{ field: "apiKey", required: true }] }, /credential reference field/);
  refused({ ...good, verify: { ...good.verify, probes: { api: { path: "/x" } } } }, /must be \{path, header\}/);
  refused({ ...good, verify: { ...good.verify, health: { path: "http://elsewhere/health" } } }, /not an absolute path/);
  assert.equal(validateSpec({ ...good, version: "anything" }, target).ok, true, "version is display-only");
});

test("the dashboard's live spec (1.3.13, read without a key) passes as the format owner froze it", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("./fixtures/aify-dashboard-spec-1.3.13.json", import.meta.url), "utf8"));
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

test("a package from git: a full commit only, no sha256, and its approval binds {kind, repo, entries} with the revision from the spec", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("./fixtures/aify-dashboard-spec-1.3.13.json", import.meta.url), "utf8"));
  const dashboard = { name: "aify-dashboard", endpoint: "http://127.0.0.1:9700" };
  const [pkg] = spec.artifacts;
  const withArtifact = (change) => ({ ...spec, artifacts: [{ ...pkg, ...change }] });
  const at = (revision) => ({ source: { git: { repo: pkg.source.git.repo, revision } } });
  assert.deepEqual(validateSpec(withArtifact({}), dashboard).errors, [], "CONTROL: the live shape passes");
  for (const revision of [pkg.source.git.revision.slice(0, 12), "main", "v1.3.13", pkg.source.git.revision.toUpperCase()]) {
    assert.match(validateSpec(withArtifact(at(revision)), dashboard).errors.join(";"), /full 40-hex commit/, revision);
  }
  assert.match(validateSpec(withArtifact({ sha256: "a".repeat(64) }), dashboard).errors.join(";"), /package from git and may not carry a sha256/);
  assert.equal(tupleDigest(pkg), tupleDigest({ ...pkg, ...at("b".repeat(40)) }), "the revision is the spec's, not the approval's");
  for (const change of [{ source: { git: { repo: "someone/else", revision: pkg.source.git.revision } } }, { entries: ["other-bin"] }, { kind: "file-set" }]) {
    assert.notEqual(tupleDigest(pkg), tupleDigest({ ...pkg, ...change }), JSON.stringify(change));
  }
});

test("an installed package: npm's one dependency names the commit, and an entry is a bin the package declares", () => {
  const sha = "c".repeat(40);
  assert.deepEqual(installedCommit({ dependencies: { b: { resolved: `git+ssh://git@github.com/o/r.git#${sha}` } } }), { name: "b", commit: sha, problem: "" });
  assert.match(installedCommit({ dependencies: { b: { version: "1.0.0" } } }).problem, /no commit for b/);
  assert.match(installedCommit({ dependencies: {} }).problem, /0 packages/);
  assert.match(installedCommit({ dependencies: { a: {}, b: {} } }).problem, /2 packages/);
  assert.deepEqual(binFiles({ name: "@s/tool", bin: "./cli.js" }, ["tool"]), { files: { tool: "cli.js" }, problems: [] });
  assert.deepEqual(binFiles({ name: "p", bin: { a: "dist/a.js" } }, ["a"]).files, { a: "dist/a.js" });
  assert.match(binFiles({ name: "p", bin: { a: "dist/a.js" } }, ["b"]).problems[0], /b is not a bin p declares \(it declares a\)/);
  assert.match(binFiles({ name: "p", bin: { a: "../x.js" } }, ["a"]).problems[0], /leaves the package/);
  assert.deepEqual(installArgs("/p", { repo: "o/r", revision: sha }), ["install", "--prefix", "/p", "--ignore-scripts=false", "--no-audit", "--no-fund", `github:o/r#${sha}`]);
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

test("parseManifest reads sha256sum lines and refuses traversal, absolute paths, backslashes, disorder and a missing line feed", () => {
  const h = "a".repeat(64);
  const LF = String.fromCharCode(10);
  const ok = parseManifest(`${h}  a.js${LF}${h}  sub/b.js${LF}`);
  assert.deepEqual([...ok.files.keys()], ["a.js", "sub/b.js"]);
  for (const [text, pattern] of [
    [`${h}  ../x.js${LF}`, /not a relative path/],
    [`${h}  /etc/x${LF}`, /not a relative path/],
    [`${h}  a${String.fromCharCode(92)}b.js${LF}`, /not a relative path/],
    [`${h}  b.js${LF}${h}  a.js${LF}`, /out of order/],
    [`${h}  a.js`, /line feed/],
    [`${h} a.js${LF}`, /not "<sha256>  <path>"/],
  ]) assert.match(parseManifest(text).errors.join(";"), pattern);
});

test("checkFileSet holds every listed file to its line, requires every entry listed, and only reports extras", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-fileset-"));
  fs.writeFileSync(path.join(dir, "a.js"), "a");
  fs.writeFileSync(path.join(dir, "extra.js"), "x");
  const listed = new Map([["a.js", createHash("sha256").update("a").digest("hex")]]);
  assert.deepEqual(checkFileSet(dir, listed, ["a.js"]), { problems: [], unlisted: ["extra.js"] });
  assert.match(checkFileSet(dir, listed, ["a.js", "b.js"]).problems.join(";"), /entry b\.js is not in the manifest/);
  fs.writeFileSync(path.join(dir, "a.js"), "changed");
  assert.match(checkFileSet(dir, listed, ["a.js"]).problems.join(";"), /a\.js hashes .*, not its manifest line/);
});

test("aifyEnvTools runs aify-env's commands and turns a non-zero exit into a refusal naming the command", () => {
  const tools = aifyEnvTools(FAKE_ENV, { ...process.env, AIFY_TEST_FAIL: "registry-check" });
  assert.throws(() => tools.registryCheck("x"), (error) => error instanceof Refused && /aify-env registry check failed/.test(error.message));
  assert.equal(typeof connect, "function");
});

test("registry check: a non-zero exit refuses before its output is trusted, and an exit 0 must carry a passing verdict", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-check-exit-"));
  const bin = path.join(dir, "aify-env.mjs");
  // Answers as ANSWER says: `<exit>|<stdout>|<stderr>`.
  fs.writeFileSync(bin, 'const [code, out, err] = process.env.ANSWER.split("|"); process.stdout.write(out); process.stderr.write(err); process.exit(Number(code));\n');
  const verdict = (ok, problems, warnings = []) => JSON.stringify({ check: 1, ok, references: [], problems, warnings });
  const problem = { code: "credential-ref-collision", service: "s", field: "credentialRef", detail: "shared" };
  const answer = (value) => aifyEnvTools(bin, { ...process.env, ANSWER: value });
  const refusal = (value, pattern) => assert.throws(() => answer(value).registryCheck("f", "s"), (e) => e instanceof Refused && pattern.test(e.message), value);
  refusal("64||usage: registry check [--candidate-only | --service <name>] <file>", /failed: exit 64: usage: registry check/);
  refusal("65||cannot read f: ENOENT", /failed: exit 65: cannot read f: ENOENT/);
  refusal(`65|${verdict(false, [problem])}|`, /failed: credential-ref-collision: s\.credentialRef: shared/);
  refusal(`65|${verdict(true, [], [{ service: "x", field: "credentialRef", detail: "w" }])}|`, /failed: exit 65/); // a non-zero exit is never read as a pass
  refusal("0|not json|", /exited 0 without a passing verdict/);
  refusal(`0|${verdict(false, [problem])}|`, /exited 0 without a passing verdict/);
  assert.deepEqual(answer(`0|${verdict(true, [], [{ service: "x", field: "credentialRef", detail: "w" }])}|`).registryCheck("f", "s"), ["x.credentialRef: w"], "CONTROL");
  assert.deepEqual(answer(`0|${verdict(true, [])}|`).registryCheckCandidate("f"), [], "CONTROL: candidate-only");
});

test("HTTP: no redirect is followed, a probe sends the real key last, and served bytes are checked against their hash", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers["x-k"] ?? "-"}`);
    if (req.url === "/.well-known/aify-service") return res.writeHead(301, { location: "http://elsewhere/" }).end();
    if (req.url === "/health") return res.writeHead(200).end();
    if (req.url === "/m") return res.writeHead(200, { "content-type": "text/plain" }).end("manifest");
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
    const artifact = { id: "t", sha256: createHash("sha256").update("bytes").digest("hex"), source: { served: { path: "/t.tgz", version: "1" } } };
    assert.equal((await fetchServed(url, artifact, "x-k", "KEY")).toString(), "bytes");
    await assert.rejects(fetchServed(url, { ...artifact, sha256: "0".repeat(64) }, "x-k", "KEY"), /not the spec's/);
    assert.ok(REQUEST_TIMEOUT_MS > 0);
    const m = { id: "m", sha256: createHash("sha256").update("manifest").digest("hex"), manifest: { path: "/m" } };
    assert.equal(await fetchManifest(url, m), "manifest");
    await assert.rejects(fetchManifest(url, { ...m, sha256: "0".repeat(64) }), /the manifest hashes/);
    assert.ok(seen.includes("/m -"), "the manifest is fetched with no key");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP: a request that never reaches the service names its url and the network's reason", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(fetchSpec(`http://127.0.0.1:${port}`), /127\.0\.0\.1:\d+\/\.well-known\/aify-service: request failed \(ECONNREFUSED/);
});

test("HTTP: every request opens its own connection, so none can land on a socket the service's keep-alive timeout is closing", async () => {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.writeHead(req.url === "/health" || req.headers["x-k"] === "right" ? 200 : 401, { "content-type": "application/json" });
    res.end("{}");
  });
  server.on("connection", () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    await checkHealth(endpoint, { verify: { health: { path: "/health" } } });
    await checkProbe(endpoint, { path: "/p", header: "x-k" }, "right");
    assert.equal(requests, 4, "CONTROL: health, then the probe's three requests");
    assert.equal(connections, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
