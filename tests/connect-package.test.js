// A package artifact from git, installed for real: npm runs against a bare repository this file builds, inside a
// sealed home, cache and prefix. The rules are the operator's (guided install S1, package + git): a full commit,
// scripts on, the installed commit read back, every entry a declared bin, no sha256.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { KEY, approvals, gitPackage, makeHost, runConnect, startService } from "./connect-fixture.mjs";

/** The dashboard's live shape (1.3.13), with its bridge pointed at the fixture repository. */
function packageSpec({ revision, entry = "fixture-bridge" } = {}) {
  const git = gitPackage();
  return {
    specVersion: 1,
    name: "aify-dashboard",
    version: "1.3.13",
    fixed: { agentState: { path: "/api/v1/agent-state" }, advertise: false },
    artifacts: [{ id: "dashboard-bridge", kind: "package", source: { git: { repo: git.repo, revision: revision ?? git.revisions[0] } }, entries: [entry] }],
    mcp: [{ name: "aify-dashboard", artifact: "dashboard-bridge", entry }],
    secrets: [{ field: "credentialRef", required: true, probe: "api" }],
    verify: { health: { path: "/health" }, probes: { api: { path: "/api/v1/settings/schema", header: "x-api-key" } } },
  };
}

async function connectWith(spec, env = {}, key = KEY) {
  const host = makeHost();
  const service = await startService({ spec });
  try {
    const run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(key), ...approvals(spec)], { env });
    return { host, run };
  } finally {
    await service.close();
  }
}

const packageDirs = (host) => {
  const dir = path.join(host.home, ".aify", "packages", "aify-dashboard", "dashboard-bridge");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test("INSTALL WITH SCRIPTS: the spec's commit is installed in its own prefix, prepare builds the bin, and the entry runs that bin with this node", async () => {
  const { revisions } = gitPackage();
  const { host, run } = await connectWith(packageSpec());
  assert.equal(run.status, 0, run.stderr);
  const [install] = host.npmCalls().filter((call) => call[0] === "install");
  assert.ok(install.includes("--ignore-scripts=false"), "scripts are asked for, so no npmrc can turn them off");
  assert.ok(!install.some((arg) => /^--ignore-scripts(=true)?$/.test(arg)), "nothing asks npm to skip the build");
  assert.ok(!install.some((arg) => arg === "-g" || arg === "--global"), "never the global prefix");
  assert.ok(install.includes(`github:owner/fixture-bridge#${revisions[0]}`));
  assert.equal(fs.existsSync(host.npmGlobal), false, "the sealed global prefix was never created");
  const bin = path.join(host.home, ".aify", "packages", "aify-dashboard", "dashboard-bridge", revisions[0], "node_modules", "fixture-bridge", "dist", "bridge.js")
    .split(path.sep).join("/");
  assert.ok(fs.existsSync(bin), "prepare ran: the bin it builds is on disk");
  const entry = JSON.parse(host.registryBytes().toString("utf8")).services["aify-dashboard"];
  assert.deepEqual(entry.mcp, [{ name: "aify-dashboard", command: process.execPath.split(path.sep).join("/"), args: [bin] }]);
  assert.deepEqual(packageDirs(host), [revisions[0]], "no partial directory is left");
  assert.match(run.stdout, /dashboard-bridge: installed at /);
});

test("SHORT SHA: a revision that is not a full commit is refused before npm runs or anything is written", async () => {
  const { revisions } = gitPackage();
  const { host, run } = await connectWith(packageSpec({ revision: revisions[0].slice(0, 12) }));
  assert.equal(run.status, 78);
  assert.match(run.stderr, /full 40-hex commit/);
  assert.deepEqual(host.npmCalls(), []);
  assert.equal(host.registryBytes().length, 0);
  assert.deepEqual(host.refs(), []);
});

test("WRONG COMMIT: npm installing another commit than the spec's is refused, and nothing is published or left installed", async () => {
  const { revisions } = gitPackage();
  const { host, run } = await connectWith(packageSpec(), { AIFY_TEST_NPM_REVISION: revisions[1] });
  assert.equal(run.status, 78);
  assert.match(run.stderr, new RegExp(`npm installed ${revisions[1]}, not the spec's revision ${revisions[0]}`));
  assert.ok(host.npmCalls().some((call) => call[0] === "ls"), "CONTROL: the install ran and was read back");
  assert.equal(host.registryBytes().length, 0);
  assert.deepEqual(host.refs(), [], "the staged key is removed: nothing was committed");
  assert.deepEqual(packageDirs(host), []);
});

test("NOT A BIN: an entry the installed package does not declare as a bin is refused", async () => {
  const { host, run } = await connectWith(packageSpec({ entry: "not-a-bin" }));
  assert.equal(run.status, 78);
  assert.match(run.stderr, /not-a-bin is not a bin fixture-bridge declares \(it declares fixture-bridge\)/);
  assert.equal(host.registryBytes().length, 0);
  assert.deepEqual(packageDirs(host), []);
});

test("NOT BUILT: a commit that installs but never builds its bin is refused, so an entry never points at nothing", async () => {
  const { unbuilt } = gitPackage();
  const { host, run } = await connectWith(packageSpec({ revision: unbuilt }));
  assert.equal(run.status, 78);
  assert.match(run.stderr, /fixture-bridge's bin dist\/bridge\.js is not on disk/);
  assert.equal(host.registryBytes().length, 0);
  assert.deepEqual(packageDirs(host), []);
});

test("WRONG KEY: a key the service refuses installs nothing", async () => {
  const { host, run } = await connectWith(packageSpec(), {}, "not-the-key");
  assert.equal(run.status, 78);
  assert.match(run.stderr, /\/api\/v1\/settings\/schema answered 401 to .+, not 200/);
  assert.deepEqual(host.npmCalls(), [], "npm never ran");
  assert.deepEqual(packageDirs(host), []);
});
