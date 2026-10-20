// What a connect leaves in the registry beside its own fields, and what it does to the launchers on the host.
//
// RAW PRESERVATION is measured on the dashboard's shape, because that entry carries the two fields the registry
// parser drops (`secretsCredentialRef`, `advertise`) and aify-env reads. OWNER VALIDATION is measured through the
// aify-env check connect calls: a raw field the parser never looks at must still be refused by its owner.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { KEY, ROOT, approvals, commsSpec, makeHost, runConnect, startService } from "./connect-fixture.mjs";
import { RECORD_DIR, parseRecord, registryPairs, rerenderLaunchers } from "../lib/launcher-rerender.mjs";
import { fingerprint, parseRegistry } from "../lib/registry.mjs";

function dashboardSpec() {
  return {
    specVersion: 1,
    name: "aify-dashboard",
    version: "1.3.8",
    fixed: { agentState: { path: "/api/v1/agent-state" }, sessionInject: { mcp: true }, advertise: false, turnStart: { path: "/events/turn-start", budgetMs: 800 } },
    artifacts: [{ id: "dashboard-bridge", kind: "package", source: { pending: "waits on the operator (01M5CYJH)" }, entries: ["aify-dashboard-bridge"] }],
    mcp: [{ name: "aify-dashboard", artifact: "dashboard-bridge", entry: "aify-dashboard-bridge" }],
    secrets: [{ field: "credentialRef", required: true, probe: "api" }, { field: "secretsCredentialRef", required: false }],
    verify: { health: { path: "/health" }, probes: { api: { path: "/api/v1/settings/schema", header: "x-api-key" } } },
  };
}

function seed(host, services, credentials = {}) {
  fs.mkdirSync(path.dirname(host.registry), { recursive: true });
  fs.writeFileSync(host.registry, `${JSON.stringify({ version: 1, services }, null, 2)}\n`);
  const store = path.join(host.home, ".aify", "credentials");
  fs.mkdirSync(store, { recursive: true });
  for (const [ref, value] of Object.entries(credentials)) fs.writeFileSync(path.join(store, ref), `${value}\n`);
}

function renderLauncher(host, name, template) {
  fs.mkdirSync(host.dest, { recursive: true });
  const fresh = registryPairs(host.registryBytes().toString("utf8"), template, {});
  const run = spawnSync("bash", [path.join(ROOT, "render.sh").split(path.sep).join("/"), template, path.join(host.dest, name).split(path.sep).join("/"),
    "ENDPOINT=http://127.0.0.2:1", "WRAPPER_VERSION=test", "MCP_TRANSPORT=stdio", "SERVICE_NAME=aify-comms", `BRIDGE_DIR=${host.root}`,
    `WRAPPER_DIR=${ROOT.split(path.sep).join("/")}`, "NATIVE_BASE=/n", "SCRIPT_DIR=/s", ...fresh.pairs], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return path.join(host.dest, name);
}

const bakedFingerprint = (file) => /^HARNESS_REGISTRY_FINGERPRINT="([0-9a-f]+)"$/m.exec(fs.readFileSync(file, "utf8"))?.[1];

test("RAW PRESERVATION: a dashboard reconnect keeps secretsCredentialRef and advertise byte-equal, and writes no entry for its pending bridge", async () => {
  const host = makeHost();
  const theirs = { command: "C:/node.exe", args: ["C:/checkout/bridge.ts"], name: "aify-dashboard" };
  seed(host, {
    "aify-dashboard": { endpoint: "http://old", credentialRef: "aify-dashboard.key", secretsCredentialRef: "aify-dashboard-secrets-fetch.key", advertise: false, mcp: [theirs] },
  }, { "aify-dashboard.key": KEY, "aify-dashboard-secrets-fetch.key": "fetch-secret" });
  const service = await startService({ spec: dashboardSpec() });
  try {
    const run = await runConnect(host, ["aify-dashboard", service.url]);
    assert.equal(run.status, 0, run.stderr);
    const entry = JSON.parse(host.registryBytes()).services["aify-dashboard"];
    assert.equal(entry.secretsCredentialRef, "aify-dashboard-secrets-fetch.key");
    assert.equal(entry.advertise, false);
    assert.equal(entry.credentialRef, "aify-dashboard.key", "the published key was reused");
    assert.deepEqual(entry.mcp, [theirs], "a pending artifact's existing server is neither replaced nor deleted");
    assert.equal(entry.endpoint, service.url);
    assert.match(run.stdout, /mcp aify-dashboard: no entry written -- waits on the operator/);
    assert.match(run.stdout, /secretsCredentialRef: stored, not probed/);
    assert.ok(parseRegistry(host.registryBytes().toString("utf8")).ok);
  } finally {
    await service.close();
  }
});

test("TYPED SECRETS: an optional secret that is absent is a working state, reported as such", async () => {
  const host = makeHost();
  const service = await startService({ spec: dashboardSpec() });
  try {
    const run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(KEY)]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /secretsCredentialRef: optional, not supplied/);
    assert.equal(JSON.parse(host.registryBytes()).services["aify-dashboard"].secretsCredentialRef, undefined);
  } finally {
    await service.close();
  }
});

test("OWNER VALIDATION: a raw reference that case-folds onto another service's is refused by aify-env's check, and nothing is written", async () => {
  const host = makeHost();
  seed(host, {
    "aify-comms": { endpoint: "http://old", backupCredentialRef: "Shared.key", mcp: [] },
    other: { endpoint: "http://other", credentialRef: "shared.key" },
  });
  const before = host.registryBytes();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /aify-env registry check failed: "shared.key" is claimed by both/i);
    assert.deepEqual(host.registryBytes(), before);
    assert.deepEqual(host.refs(), [], "the staged reference was removed");
    assert.ok(host.calls().some((argv) => argv[0] === "registry"), "CONTROL: the check was asked");
  } finally {
    await service.close();
  }
});

test("RE-RENDER: a recorded launcher is re-rendered for the new registry after a commit; one with no record is reported stale", async () => {
  const host = makeHost();
  const recorded = renderLauncher(host, "claude-aify", "claude-aify.sh.in");
  fs.copyFileSync(recorded, path.join(host.dest, "codex-aify"));
  const before = bakedFingerprint(recorded);
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    const now = fingerprint(parseRegistry(host.registryBytes().toString("utf8")).registry);
    assert.notEqual(before, now, "CONTROL: the registry's fingerprint moved");
    assert.equal(bakedFingerprint(recorded), now);
    assert.match(run.stdout, /launcher claude-aify: re-rendered/);
    assert.match(run.stdout, /launcher codex-aify: stale -- no render record/);
    assert.notEqual(bakedFingerprint(path.join(host.dest, "codex-aify")), now, "the unrecorded launcher was left alone");
  } finally {
    await service.close();
  }
});

test("NO REPLACEMENT ON FAILURE: a refused connect leaves a recorded launcher byte for byte", async () => {
  const host = makeHost();
  const launcher = renderLauncher(host, "claude-aify", "claude-aify.sh.in");
  // STALE BEFORE THE CONNECT, so a re-render would change it: with an unchanged registry it renders to the same bytes,
  // and a witness on those bytes could not tell a refused connect that re-rendered from one that did not.
  seed(host, { other: { endpoint: "http://other" } });
  const bytes = fs.readFileSync(launcher);
  assert.notEqual(bakedFingerprint(launcher), fingerprint(parseRegistry(host.registryBytes().toString("utf8")).registry), "CONTROL: it is stale");
  const spec = commsSpec(host);
  const service = await startService({ spec, answer: (req) => (req.url === "/api/v1/agents" ? { status: 401 } : null) });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.deepEqual(fs.readFileSync(launcher), bytes);
  } finally {
    await service.close();
  }
});

test("the render record holds the template's hash, its name and the installer's pairs, and never the registry-derived four", () => {
  const host = makeHost();
  renderLauncher(host, "pi-aify", "pi-aify.sh.in");
  const record = parseRecord(fs.readFileSync(path.join(host.dest, RECORD_DIR, "pi-aify.args")));
  assert.equal(record.template, "pi-aify.sh.in");
  assert.ok(record.pairs.includes(`BRIDGE_DIR=${host.root}`));
  assert.ok(!record.pairs.some((pair) => /^(REGISTRY_FINGERPRINT|STRICT_EXTRA_MCP_B64|SESSION_MCP_B64|SESSION_MCP_CODEX_B64)=/.test(pair)));
  assert.equal(parseRecord(Buffer.from("not a record")), null, "a malformed record is no record");
  assert.deepEqual(rerenderLaunchers({ dest: path.join(host.home, "absent"), registryPath: host.registry, wrapperRoot: ROOT }), []);
});
