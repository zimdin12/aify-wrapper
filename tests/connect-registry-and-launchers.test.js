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

import { KEY, ROOT, approvals, commsSpec, makeHost, runConnect, startService, storeCredential } from "./connect-fixture.mjs";
import { parseRecord, recordDirFor, registryPairs, rerenderLaunchers } from "../lib/launcher-rerender.mjs";
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
  for (const [ref, value] of Object.entries(credentials)) storeCredential(host, ref, value);
}

function renderLauncher(host, name, template, record = true) {
  fs.mkdirSync(host.dest, { recursive: true });
  const fresh = registryPairs(host.registryBytes().toString("utf8"), template, {});
  const run = spawnSync("bash", [path.join(ROOT, "render.sh").split(path.sep).join("/"), template, path.join(host.dest, name).split(path.sep).join("/"),
    "ENDPOINT=http://127.0.0.2:1", "WRAPPER_VERSION=test", "MCP_TRANSPORT=stdio", "SERVICE_NAME=aify-comms", `BRIDGE_DIR=${host.root}`,
    `WRAPPER_DIR=${ROOT.split(path.sep).join("/")}`, "NATIVE_BASE=/n", "SCRIPT_DIR=/s", ...fresh.pairs],
    { encoding: "utf8", env: { ...process.env, ...(record ? { RENDER_RECORD_DIR: recordDirFor(host.registry) } : {}) } });
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
  }, { "Shared.key": "a key" }); // stored, so the collision is the only thing the check can refuse
  const before = host.registryBytes();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 78);
    assert.match(run.stderr, /aify-env registry check failed: credential-ref-collision: .*'shared\.key' is also .*credential file/);
    assert.doesNotMatch(run.stderr, /credential-store/, "the collision alone refused it");
    assert.deepEqual(host.registryBytes(), before);
    assert.deepEqual(host.refs(), ["Shared.key"], "the seeded reference stays");
    assert.deepEqual(host.calls().filter((argv) => argv[0] === "credential"), [], "refused in prepare, before any key was staged");
    assert.ok(host.calls().some((argv) => argv[0] === "registry" && argv.includes("--candidate-only")), "CONTROL: the candidate check was asked");
  } finally {
    await service.close();
  }
});

test("CHECK ORDER: prepare asks the candidate-only check before any key is staged; the store-aware check runs after staging", async () => {
  const host = makeHost();
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    const calls = host.calls().map((argv) => argv.slice(0, 3).join(" "));
    const candidate = calls.indexOf("registry check --candidate-only");
    const staged = calls.indexOf("credential set --service");
    const scoped = calls.indexOf("registry check --service");
    assert.ok(candidate !== -1 && staged !== -1 && scoped !== -1, calls.join(" / "));
    assert.ok(candidate < staged && staged < scoped, calls.join(" / "));
    assert.equal(calls.filter((c) => c.startsWith("registry")).length, 2, "one check of each kind");
  } finally {
    await service.close();
  }
});

test("SCOPED CHECK: another service's missing key does not block a connect, and the operator is shown it", async () => {
  const host = makeHost();
  seed(host, { other: { endpoint: "http://other", credentialRef: "other.key" } });
  const spec = commsSpec(host);
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /warning \(another service, not blocking\): other\.credentialRef: CREDENTIAL_MISSING/);
    assert.ok(host.calls().some((argv) => argv[0] === "registry" && argv.includes("--service") && argv.includes("aify-comms")), "the check was scoped");
  } finally {
    await service.close();
  }
});

test("RE-RENDER: a recorded launcher is re-rendered for the new registry after a commit; one with no record is reported stale", async () => {
  const host = makeHost();
  const recorded = renderLauncher(host, "claude-aify", "claude-aify.sh.in");
  fs.copyFileSync(recorded, path.join(host.dest, "codex-aify"));
  // npm's bin for this package's own `herdr-aify` lands in the same directory when the prefix is ~/.local; no template
  // here renders it, so it is not a launcher (fresh-install report, 2026-10-25).
  fs.writeFileSync(path.join(host.dest, "herdr-aify"), "#!/bin/sh\n");
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
    assert.doesNotMatch(run.stdout, /launcher herdr-aify/);
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

test("install.sh records each launcher beside the registry it was built against, and --render-only records nothing", () => {
  const host = makeHost();
  fs.mkdirSync(path.dirname(host.registry), { recursive: true });
  fs.writeFileSync(host.registry, "{\"version\":1,\"services\":{}}\n");
  const install = (...extra) => spawnSync("bash", [path.join(ROOT, "install.sh").split(path.sep).join("/"), "--client", "claude",
    "--endpoint", "http://127.0.0.2:1", "--registry", host.registry.split(path.sep).join("/"), ...extra],
  { encoding: "utf8", env: { ...process.env, HOME: host.home, USERPROFILE: host.home } });
  const only = path.join(host.home, "render-only");
  assert.equal(install("--render-only", only.split(path.sep).join("/")).status, 0);
  assert.ok(!fs.existsSync(recordDirFor(host.registry)), "--render-only touched nothing outside its directory");
  const run = install("--dest", host.dest.split(path.sep).join("/"));
  assert.equal(run.status, 0, run.stderr);
  const records = fs.readdirSync(recordDirFor(host.registry)).map((name) => parseRecord(fs.readFileSync(path.join(recordDirFor(host.registry), name))));
  assert.deepEqual(records.map((r) => path.basename(r.target)), ["claude-aify"]);
  assert.deepEqual(fs.readdirSync(host.dest), ["claude-aify"]);
});

test("GIT-BASH: a launcher rendered under an MSYS path records the native target, and re-renders from it", { skip: process.platform !== "win32" && "MSYS paths exist only under git-bash on Windows" }, () => {
  // Every launcher install.sh writes from git-bash is named the way that shell spells HOME: `/c/Users/...`. Node reads
  // `/c/...` as `C:\c\...`, so a record holding that form names no file and its launcher read stale (2026-10-21).
  // Under the test runner's TEMP the git-bash spelling is a mount, `/tmp/...`, which only cygpath can map back.
  const host = makeHost();
  seed(host, {});
  const native = path.join(host.dest, "claude-aify").split(path.sep).join("/");
  const msys = spawnSync("cygpath", ["-u", native], { encoding: "utf8" }).stdout.trim();
  assert.ok(msys.startsWith("/") && msys !== native, `CONTROL: the target is spelled as git-bash spells it: ${msys}`);
  fs.mkdirSync(host.dest, { recursive: true });
  const run = spawnSync("bash", [path.join(ROOT, "render.sh").split(path.sep).join("/"), "claude-aify.sh.in", msys,
    "ENDPOINT=http://127.0.0.2:1", "WRAPPER_VERSION=test", "MCP_TRANSPORT=stdio", "SERVICE_NAME=aify-comms", `BRIDGE_DIR=${host.root}`,
    `WRAPPER_DIR=${ROOT.split(path.sep).join("/")}`, "NATIVE_BASE=/n", "SCRIPT_DIR=/s", ...registryPairs(host.registryBytes().toString("utf8"), "claude-aify.sh.in", {}).pairs],
  { encoding: "utf8", env: { ...process.env, RENDER_RECORD_DIR: recordDirFor(host.registry) } });
  assert.equal(run.status, 0, run.stderr);
  const [file] = fs.readdirSync(recordDirFor(host.registry));
  assert.equal(parseRecord(fs.readFileSync(path.join(recordDirFor(host.registry), file))).target, native);
  const rows = rerenderLaunchers({ dest: host.dest, registryPath: host.registry, wrapperRoot: ROOT });
  assert.deepEqual(rows.map((row) => [row.name, row.state]), [["claude-aify", "re-rendered"]]);
  assert.deepEqual(fs.readdirSync(recordDirFor(host.registry)), [file], "the re-render rewrote its own record, not a second one");
});

test("the render record holds the template's hash, its name and the installer's pairs, and never the registry-derived four", () => {
  const host = makeHost();
  const launcher = renderLauncher(host, "pi-aify", "pi-aify.sh.in");
  const [file, ...more] = fs.readdirSync(recordDirFor(host.registry));
  assert.deepEqual(more, [], "one record per launcher");
  const record = parseRecord(fs.readFileSync(path.join(recordDirFor(host.registry), file)));
  assert.equal(record.template, "pi-aify.sh.in");
  assert.equal(record.target, launcher.split(path.sep).join("/"));
  assert.deepEqual(fs.readdirSync(host.dest), ["pi-aify"], "the launcher directory, on PATH, gains nothing but the launcher");
  renderLauncher(host, "claude-aify", "claude-aify.sh.in", false);
  assert.equal(fs.readdirSync(recordDirFor(host.registry)).length, 1, "a render that did not ask leaves no record");
  assert.deepEqual(fs.readdirSync(host.dest).sort(), ["claude-aify", "pi-aify"], "...anywhere, the launcher directory included");
  assert.ok(record.pairs.includes(`BRIDGE_DIR=${host.root}`));
  assert.ok(!record.pairs.some((pair) => /^(REGISTRY_FINGERPRINT|STRICT_EXTRA_MCP_B64|SESSION_MCP_B64|SESSION_MCP_CODEX_B64)=/.test(pair)));
  assert.equal(parseRecord(Buffer.from("not a record")), null, "a malformed record is no record");
  const bare = makeHost();
  assert.deepEqual(rerenderLaunchers({ dest: path.join(bare.home, "absent"), registryPath: bare.registry, wrapperRoot: ROOT }), [], "no records and no launchers: nothing to report");
});

// aify-comms 0.9.11: the guided chain renders with no --mcp-transport, so the service's spec declares its transport
// (`fixed.mcpTransport`), connect writes it into the registry entry, and re-rendering applies it over the recorded one.
const liveTransport = (file) => (/^\s*if \[ "([a-z]+)" = "http" \]; then$/m.exec(fs.readFileSync(file, "utf8")) || [])[1];

for (const [declared, expected] of [["http", "http"], [undefined, "stdio"]]) {
  test(`TRANSPORT: a spec declaring ${declared ?? "nothing"} re-renders a recorded stdio launcher as ${expected}`, async () => {
    const host = makeHost();
    const recorded = renderLauncher(host, "claude-aify", "claude-aify.sh.in");
    assert.equal(liveTransport(recorded), "stdio", "CONTROL: the launcher was rendered stdio");
    const base = commsSpec(host);
    const spec = declared ? commsSpec(host, { fixed: { ...base.fixed, mcpTransport: declared } }) : base;
    const service = await startService({ spec });
    try {
      const run = await runConnect(host, ["aify-comms", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)]);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(parseRegistry(host.registryBytes().toString("utf8")).registry.services["aify-comms"].mcpTransport, declared);
      assert.match(run.stdout, /launcher claude-aify: re-rendered/);
      assert.equal(liveTransport(recorded), expected);
    } finally {
      await service.close();
    }
  });
}
