// aify-wrapper-connect, run for real against a service in this process and aify-env's own credential command.
//
// One test per obligation of guided-install S1 and its format freeze, each named for what it would catch. The
// control comes first: a connect that writes comms' entry exactly as comms' own installer does, with the absolute
// node the freeze requires, is what every refusal below is measured against.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { KEY, ROOT, approvals, commsSpec, makeHost, runConnect, startService } from "./connect-fixture.mjs";

const fixture = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "services-written-by-aify-comms.json"), "utf8");
const credentialSets = (host) => host.calls().filter((argv) => argv[0] === "credential");

test("CONTROL: comms connects, and the registry is byte-equal to what comms' installer writes, with an absolute node", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    const written = host.registryBytes().toString("utf8");
    const ref = JSON.parse(written).services["aify-comms"].credentialRef;
    assert.match(ref, /^aify-comms-credentialRef-[0-9a-f]{10}$/);
    const expected = fixture
      .replaceAll("http://127.0.0.2:1", service.url)
      .replaceAll("/opt/aify/mcp/stdio", host.root)
      .replaceAll('"command": "node"', `"command": ${JSON.stringify(process.execPath.split(path.sep).join("/"))}`)
      .replace('  "endpoint"', `  "credentialRef": ${JSON.stringify(ref)},\n      "endpoint"`)
      .replace('      "credentialRef"', '      "credentialRef"');
    assert.equal(written, expected.replace(`},\n  "credentialRef"`, `},\n      "credentialRef"`));
    assert.deepEqual(host.refs(), [ref], "the key is in aify-env's store under the published reference");
    assert.equal(fs.readFileSync(path.join(host.home, ".aify", "credentials", ref), "utf8"), `${KEY}\n`);
    assert.deepEqual(service.requests.filter((r) => r.path === "/api/v1/agents").map((r) => r.keyed), ["none", "wrong", "right"]);
  } finally {
    await service.close();
  }
});

for (const [label, mutate] of [
  ["another name", (spec) => ({ ...spec, name: "aify-dashboard" })],
  ["a route that leaves the origin", (spec) => ({ ...spec, verify: { ...spec.verify, health: { path: "//elsewhere.example/health" } } })],
  ["fixed setting the endpoint", (spec) => ({ ...spec, fixed: { ...spec.fixed, endpoint: "http://elsewhere.example" } })],
  ["fixed setting a credential reference", (spec) => ({ ...spec, fixed: { ...spec.fixed, agentState: { path: "/x", credentialRef: "aify-env.key" } } })],
  ["a dangling probe name", (spec) => ({ ...spec, secrets: [{ field: "credentialRef", required: true, probe: "nope" }] })],
]) {
  test(`METADATA: a spec with ${label} is refused before any credential is touched`, async () => {
    const host = makeHost();
    const spec = mutate(commsSpec(host));
    const service = await startService({ spec });
    try {
      const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
      assert.equal(run.status, 78, run.stdout);
      assert.match(run.stderr, /the spec is refused/);
      assert.deepEqual(host.calls(), [], "aify-env was never asked for anything");
      assert.equal(host.registryBytes().length, 0);
      assert.ok(!service.requests.some((r) => r.keyed !== "none"), "no request carried a key");
    } finally {
      await service.close();
    }
  });
}

test("METADATA: a redirect on the unauthenticated spec fetch is refused, and nothing is requested at its Location", async () => {
  const host = makeHost();
  const elsewhere = await startService({ spec: commsSpec(host) });
  const service = await startService({ answer: (req) => (req.url === "/.well-known/aify-service" ? { status: 302, location: `${elsewhere.url}/.well-known/aify-service` } : null) });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /redirects are never followed/);
    assert.deepEqual(elsewhere.requests, []);
    assert.deepEqual(host.calls(), []);
  } finally {
    await service.close();
    await elsewhere.close();
  }
});

for (const [label, answer] of [
  ["a 200 web page", { status: 200, body: "<!doctype html><title>dashboard</title>", type: "text/html" }],
  ["a 401 JSON refusal", { status: 401, body: "{\"error\":\"unauthorized\"}" }],
  ["a 404", { status: 404, body: "{}" }],
]) {
  test(`NO SPEC: ${label} at the spec path is "serves no spec", refused before any credential is read or written`, async () => {
    const host = makeHost();
    const service = await startService({ answer: (req) => (req.url === "/.well-known/aify-service" ? answer : null) });
    try {
      const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY)]);
      assert.equal(run.status, 78);
      assert.match(run.stderr, /serves no spec/);
      assert.doesNotMatch(run.stderr, /the spec is refused/, "never read as a malformed spec");
      assert.deepEqual(host.calls(), []);
      assert.equal(host.registryBytes().length, 0);
      assert.ok(!service.requests.some((r) => r.keyed !== "none"), "no request carried a key");
    } finally {
      await service.close();
    }
  });
}

test("AUTH-DEPENDENT REDIRECT: a probe that redirects only the right key aborts, forwards nothing, and changes nothing", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const elsewhere = await startService({ spec });
  const service = await startService({
    spec,
    answer: (req, keyed) => (req.url === "/api/v1/agents" ? (keyed === "right" ? { status: 302, location: `${elsewhere.url}/steal` } : { status: 401 }) : null),
  });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /answered 302 towards .*steal; redirects are never followed/);
    assert.deepEqual(elsewhere.requests, [], "the key went nowhere else");
    assert.equal(host.registryBytes().length, 0);
    assert.deepEqual(host.refs(), [], "the staged reference was removed");
  } finally {
    await service.close();
    await elsewhere.close();
  }
});

test("ORIGIN-RELATIVE: an endpoint with a path probes the origin's route, never a concatenation", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", `${service.url}/comms`, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(service.requests.some((r) => r.path === "/api/v1/agents"));
    assert.ok(!service.requests.some((r) => r.path.startsWith("/comms/")), JSON.stringify(service.requests));
  } finally {
    await service.close();
  }
});

for (const [label, mutate, expect] of [
  ["an unapproved tuple", (spec) => spec, /not approved/],
  ["files that do not hash to the approved sha256", (spec) => spec, /hash .*, not the approved/],
  ["a server naming a command", (spec) => ({ ...spec, mcp: [{ ...spec.mcp[0], command: "calc.exe" }] }), /never a command/],
]) {
  test(`TYPED ARTIFACTS: ${label} is refused under --no-prompt, and nothing runs or is written`, async () => {
    const host = makeHost();
    const spec = mutate(commsSpec(host));
    const service = await startService({ spec });
    try {
      const approve = label === "an unapproved tuple" ? [] : approvals(spec);
      if (label.startsWith("files")) fs.appendFileSync(path.join(host.home, ".aify-comms", "mcp", "stdio", "server.js"), "// changed\n");
      const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approve]);
      assert.equal(run.status, 78);
      assert.match(run.stderr, expect);
      assert.deepEqual(credentialSets(host), []);
      assert.equal(host.registryBytes().length, 0);
    } finally {
      await service.close();
    }
  });
}

test("NO REPLACEMENT ON FAILURE: a wrong key on reconnect leaves the registry, its reference and the launchers as they were", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    assert.equal((await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)])).status, 0);
    const registry = host.registryBytes();
    const refs = host.refs();
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile("not-the-key", "wrong"), ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /answered 401 to the key, not 200/);
    assert.deepEqual(host.registryBytes(), registry);
    assert.deepEqual(host.refs(), refs, "the old reference stays and the staged one is gone");
  } finally {
    await service.close();
  }
});

test("NO REPLACEMENT ON FAILURE: a service that answers 200 without a key never receives the key, and nothing is written", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec, answer: (req) => (req.url === "/api/v1/agents" ? { status: 200, body: "{}" } : null) });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /answered 200 to no key, not 401/);
    assert.ok(!service.requests.some((r) => r.keyed === "right"), "the real key was never sent");
    assert.equal(host.registryBytes().length, 0);
    assert.deepEqual(host.refs(), []);
  } finally {
    await service.close();
  }
});

test("MISSING KEY: a required secret neither stored nor supplied stops before anything is staged or written", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /credentialRef is required and none is stored or supplied/);
    assert.deepEqual(host.calls(), []);
    assert.equal(host.registryBytes().length, 0);
    assert.ok(!fs.existsSync(host.dest), "nothing was rendered");
  } finally {
    await service.close();
  }
});

test("KEY NOT IN ARGV: a flag that would carry the key is refused by name", async () => {
  const host = makeHost();
  const run = await runConnect(host, ["aify-comms", "http://127.0.0.1:9", `--key=${KEY}`]);
  assert.equal(run.status, 78);
  assert.match(run.stderr, /--key would put a key in argv/);
  assert.ok(!run.stderr.includes(KEY));
});

test("REUSE: a reconnect with no new key reuses the published reference and stages nothing", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    assert.equal((await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)])).status, 0);
    const before = credentialSets(host).length;
    const run = await runConnect(host, ["aify-comms", service.url, ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(credentialSets(host).length, before, "nothing was staged");
    assert.equal(host.refs().length, 1);
  } finally {
    await service.close();
  }
});

test("RETIREMENT: a new key leaves the old reference in the store and reports it cleanup-pending", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    assert.equal((await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)])).status, 0);
    const [old] = host.refs();
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY, "again"), ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(host.refs().includes(old), "connect removed no old reference");
    assert.match(run.stdout, new RegExp(`cleanup-pending: credentialRef no longer names ${old}`));
  } finally {
    await service.close();
  }
});

test("SESSION IDENTITY: every AIFY_* variable and a planted key in connect's environment stay out of the entry", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  const planted = {
    AIFY_AGENT_ID: "planted-agent-id-7f3a", AIFY_SESSION_HANDLE: "planted-handle-91c2", AIFY_HOME: "planted-home-55d0",
    AIFY_API_KEY: "planted-api-key-0c4e", AIFY_SERVER_URL: "http://planted-server-3b1d", CLAUDE_MCP_API_KEY: "planted-claude-key-a8e6",
  };
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)], { env: planted });
    assert.equal(run.status, 0, run.stderr);
    const written = host.registryBytes().toString("utf8");
    assert.ok(written.includes("aify-comms-channel"), "CONTROL: the entry is there to be searched");
    for (const value of [...Object.values(planted), KEY]) assert.ok(!written.includes(value), `${value} leaked into the registry`);
  } finally {
    await service.close();
  }
});
