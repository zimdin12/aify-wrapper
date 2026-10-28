// A field an earlier spec's `fixed` published, which a newer spec no longer sets: reported, and removed only by
// `--drop`. Connect cannot tell its own earlier write from the service's own installer's (lib/connect-entry.mjs
// leftoverFixed), so removing it is the operator's call, made where they see it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { KEY, approvals, commsSpec, makeHost, runConnect, startService } from "./connect-fixture.mjs";
import { dropProblem, leftoverFixed } from "../lib/connect-entry.mjs";
import { FIXED_FIELDS } from "../lib/service-spec.mjs";
import { parseRegistry } from "../lib/registry.mjs";

/** comms connected with its usual spec, then a newer one that sets no agentState, run with `args`. */
async function reconnectWithout(args) {
  const host = makeHost();
  const v1 = commsSpec(host);
  const first = await startService({ spec: v1 });
  try {
    const run = await runConnect(host, ["aify-comms", first.url, "--key-file", host.keyFile(KEY), ...approvals(v1)]);
    assert.equal(run.status, 0, `CONTROL: the first connect publishes: ${run.stderr}`);
  } finally {
    await first.close();
  }
  const { agentState, ...rest } = v1.fixed;
  const v2 = commsSpec(host, { fixed: rest });
  const published = host.registryBytes();
  const refs = host.refs();
  const second = await startService({ spec: v2 });
  try {
    const run = await runConnect(host, ["aify-comms", second.url, "--key-file", host.keyFile(KEY), ...approvals(v2), ...args]);
    const entry = JSON.parse(host.registryBytes()).services["aify-comms"];
    return { run, entry, published, refs, host, agentState };
  } finally {
    await second.close();
  }
}

test("a newer spec without agentState: it is reported and stays published", async () => {
  const { run, entry, agentState } = await reconnectWithout([]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(entry.agentState, agentState, "removed without being asked");
  assert.match(run.stdout, /agentState: published, not in this spec; not removed \(--drop agentState removes it\)/);
});

test("--drop agentState removes it, keeps the spec's other fields, and publishes an entry that parses", async () => {
  const { run, entry, host } = await reconnectWithout(["--drop", "agentState"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(Object.hasOwn(entry, "agentState"), false, "--drop did not remove it");
  assert.deepEqual(entry.keyEnv, ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"]);
  assert.match(run.stdout, /agentState: removed \(--drop\)/);
  assert.doesNotMatch(run.stdout, /agentState: published, not in this spec/);
  assert.equal(parseRegistry(host.registryBytes().toString("utf8")).ok, true);
});

for (const [drop, refusal] of [["endpoint", /--drop endpoint: not a field a spec's fixed sets/], ["keyEnv", /--drop keyEnv: this spec sets it/]]) {
  test(`--drop ${drop} is refused before anything is staged or written`, async () => {
    const { run, published, refs, host } = await reconnectWithout(["--drop", drop]);
    assert.equal(run.status, 78, run.stdout);
    assert.match(run.stderr, refusal);
    assert.deepEqual(host.registryBytes(), published, "the registry changed");
    assert.deepEqual(host.refs(), refs, "a key was staged");
  });
}

test("leftoverFixed names fields a spec could set, never a credential reference; dropProblem takes only those", () => {
  // A published credentialRef the spec's fixed cannot set: offering `--drop credentialRef` would invite dropping the key.
  const existing = { endpoint: "e", credentialRef: "k.key", agentState: { path: "/a" }, advertise: false, mcp: [] };
  assert.deepEqual(new Set(leftoverFixed(existing, {})), new Set(["agentState", "advertise"]));
  assert.equal(FIXED_FIELDS.includes("credentialRef"), false);
  assert.deepEqual(leftoverFixed(existing, { agentState: { path: "/b" } }), ["advertise"]);
  assert.deepEqual(leftoverFixed(undefined, {}), []);
  assert.equal(dropProblem(["agentState"], {}), "");
  assert.match(dropProblem(["credentialRef"], {}), /--drop credentialRef: not a field/);
  assert.match(dropProblem(["mcp"], {}), /--drop mcp: not a field/);
});
