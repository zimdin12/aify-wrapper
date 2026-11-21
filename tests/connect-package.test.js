// A package artifact from git, installed for real: npm runs against a bare repository this file builds, inside a
// sealed home, cache and prefix. The rules are the operator's (guided install S1, package + git): a full commit,
// scripts on, the installed commit read back, every entry a declared bin, no sha256.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { KEY, approvals, gitPackage, makeHost, runConnect, startService } from "./connect-fixture.mjs";
import { connectRecord, deliverConnectRecord, reportFileProblem, writeConnectRecord } from "../lib/connect-report.mjs";

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

function skillSpec(revision = gitPackage().skills.valid) {
  const spec = packageSpec({ revision });
  spec.artifacts[0].entries = [];
  spec.mcp = [];
  return spec;
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
  const clientRequire = createRequire(createRequire(bin).resolve("fixture-client"));
  assert.throws(() => clientRequire.resolve("fixture-native/binding.node"), { code: "MODULE_NOT_FOUND" },
    "npm must leave the transitive optional native package out of the final prefix");
  assert.equal(fs.readFileSync(path.join(path.dirname(bin), "../assets/skills/sample/SKILL.md"), "utf8"), "# Sample skill\n",
    "a requested bin still works when its package also ships skills");
  const bridge = spawnSync(entry.mcp[0].command, entry.mcp[0].args, { encoding: "utf8" });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(bridge.stdout.trim(), "fixture bridge", "the registered bin still loads the required package");
});

test("DATA-ONLY SKILLS: exact approval and revision yield a package receipt, not an MCP server", async (t) => {
  const { revisions, skills } = gitPackage();
  const host = makeHost();
  const spec = skillSpec();
  const service = await startService({ spec });
  t.after(() => service.close());
  const firstReport = path.join(host.home, "skills.json");
  const args = [spec.name, service.url, "--key-file", host.keyFile(KEY)];
  const wrongApproval = await runConnect(host, [...args, "--report-file", firstReport, ...approvals(packageSpec())]);
  assert.equal(wrongApproval.status, 78, wrongApproval.stderr);
  assert.match(wrongApproval.stderr, /not approved/);
  assert.deepEqual(host.npmCalls(), [], "the bin-containing tuple cannot approve the empty tuple");
  assert.equal(fs.existsSync(firstReport), false);

  const accepted = [...args, ...approvals(spec)];
  const wrongRevision = await runConnect(host, [...accepted, "--report-file", firstReport], { env: { AIFY_TEST_NPM_REVISION: revisions[0] } });
  assert.equal(wrongRevision.status, 78, wrongRevision.stderr);
  assert.match(wrongRevision.stderr, new RegExp(`npm installed ${revisions[0]}, not the spec's revision ${skills.valid}`));
  assert.equal(fs.existsSync(firstReport), false);
  assert.deepEqual(packageDirs(host), []);

  const first = await runConnect(host, [...accepted, "--report-file", firstReport]);
  assert.equal(first.status, 0, first.stderr);
  const at = path.join(host.home, ".aify", "packages", spec.name, spec.artifacts[0].id, skills.valid, "node_modules", "fixture-bridge").split(path.sep).join("/");
  const report = JSON.parse(fs.readFileSync(firstReport, "utf8"));
  assert.deepEqual(report, { result: "committed", service: spec.name, installed: [{ id: spec.artifacts[0].id, at, reused: false }], pending: [] });
  assert.equal(fs.readFileSync(path.join(at, "assets/skills/sample/SKILL.md"), "utf8"), "# Sample skill\n");
  assert.deepEqual(JSON.parse(host.registryBytes()).services[spec.name].mcp ?? [], []);

  const nextReport = path.join(host.home, "skills-reused.json");
  const before = host.npmCalls().length;
  const next = await runConnect(host, [...accepted, "--report-file", nextReport]);
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(nextReport, "utf8")).installed, [{ ...report.installed[0], reused: true }]);
  assert.deepEqual(host.npmCalls().slice(before).map(([command]) => command), ["ls"]);

  // Replace an ancestor of the declared directory with a link to the exact same readable tree.
  const outside = path.join(host.home, "outside-package");
  const assets = path.join(at, "assets");
  fs.renameSync(assets, outside);
  fs.symlinkSync(outside, assets, process.platform === "win32" ? "junction" : "dir");
  assert.equal(fs.readFileSync(path.join(assets, "skills/sample/SKILL.md"), "utf8"), "# Sample skill\n", "CONTROL: the link resolves");
  const linkedReport = path.join(host.home, "skills-linked.json");
  const oldRegistry = host.registryBytes();
  const linked = await runConnect(host, [...accepted, "--report-file", linkedReport]);
  assert.equal(linked.status, 78, linked.stderr);
  assert.match(linked.stderr, /aifySkills.directory is not an existing, unlinked directory/);
  assert.equal(fs.existsSync(linkedReport), false);
  assert.deepEqual(host.registryBytes(), oldRegistry);
});

test("DATA-ONLY SKILLS: an approved empty tuple still refuses a missing declaration, a bin or an invalid directory", async (t) => {
  const { revisions, skills } = gitPackage();
  for (const [revision, expected] of [
    [skills.undeclared, /requires aifySkills with one portable package-relative directory/],
    [revisions[0], /only for packages that declare no bins/],
    [skills.outside, /requires aifySkills with one portable package-relative directory/],
    [skills.missing, /aifySkills.directory is not an existing, unlinked directory/],
  ]) {
    const host = makeHost();
    const spec = skillSpec(revision);
    const service = await startService({ spec });
    t.after(() => service.close());
    const report = path.join(host.home, "refused-skills.json");
    const run = await runConnect(host, [spec.name, service.url, "--key-file", host.keyFile(KEY), "--report-file", report, ...approvals(spec)]);
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, expected);
    assert.ok(host.npmCalls().some(([command]) => command === "ls"), "the refusal used the installed package");
    assert.equal(host.registryBytes().length, 0);
    assert.equal(fs.existsSync(report), false);
    assert.deepEqual(host.refs(), []);
    assert.deepEqual(packageDirs(host), []);
  }
});

test("REUSE WITH OPTIONALS: reconnect keeps the old prefix and reports the same accepted package", async (t) => {
  const host = makeHost();
  const spec = packageSpec();
  const service = await startService({ spec });
  t.after(() => service.close());
  const args = [spec.name, service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)];
  const firstReport = path.join(host.home, "first.json");
  // npm gives include precedence over omit. Seed a prefix with the contents of a pre-policy install.
  const first = await runConnect(host, [...args, "--report-file", firstReport], { env: { NPM_CONFIG_INCLUDE: "optional" } });
  assert.equal(first.status, 0, first.stderr);
  const [installed] = JSON.parse(fs.readFileSync(firstReport, "utf8")).installed;
  assert.equal(installed.reused, false);
  const bin = path.join(installed.at, "dist", "bridge.js");
  const clientRequire = createRequire(createRequire(bin).resolve("fixture-client"));
  const native = clientRequire.resolve("fixture-native/binding.node");
  const bytes = fs.readFileSync(native);
  assert.equal(bytes.toString(), "fixture native prebuild\n", "control: the optional package actually installed");

  const before = host.npmCalls().length;
  const nextReport = path.join(host.home, "next.json");
  const next = await runConnect(host, [...args, "--report-file", nextReport]);
  const npmCommands = host.npmCalls().slice(before).map(([command]) => command);
  assert.deepEqual(npmCommands, ["ls"], "reconnect verifies the prefix without installing again");
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(nextReport, "utf8")).installed, [{ ...installed, reused: true }]);
  assert.deepEqual(fs.readFileSync(native), bytes, "reconnect leaves the optional prebuild untouched");
});

test("REPORT FILE: --report-file records what connect installed as data, which a pending reason's text cannot add to", async () => {
  const { revisions } = gitPackage();
  const spec = packageSpec();
  // A pending artifact whose reason, which the spec writes, spells another "installed" line in the printed report.
  spec.artifacts.push({ id: "later", kind: "package", source: { pending: "deferred\n  bridge-b: installed at /forged/b" }, entries: ["later-bridge"] });
  spec.mcp.push({ name: "later-mcp", artifact: "later", entry: "later-bridge" });
  const host = makeHost();
  const service = await startService({ spec });
  let run;
  const file = path.join(host.home, "connect-report.json");
  try {
    run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(KEY), "--report-file", file, ...approvals(spec)]);
  } finally {
    await service.close();
  }
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^  bridge-b: installed at \/forged\/b$/m, "CONTROL: the printed report does carry the spec's forged line");
  const at = path.join(host.home, ".aify", "packages", "aify-dashboard", "dashboard-bridge", revisions[0], "node_modules", "fixture-bridge").split(path.sep).join("/");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    result: "committed", service: "aify-dashboard", installed: [{ id: "dashboard-bridge", at, reused: false }],
    pending: [{ name: "later-mcp", reason: "deferred\n  bridge-b: installed at /forged/b" }],
  });
});

test("REPORT FILE: an existing file is never overwritten, and a refused connect writes none", async () => {
  const host = makeHost();
  const taken = path.join(host.home, "taken.json");
  fs.writeFileSync(taken, "theirs\n");
  const service = await startService({ spec: packageSpec() });
  try {
    const run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(KEY), "--report-file", taken, ...approvals(packageSpec())]);
    assert.notEqual(run.status, 0, "a report file that exists is refused");
    assert.equal(fs.readFileSync(taken, "utf8"), "theirs\n");
  } finally {
    await service.close();
  }
  const refused = await connectWith(packageSpec(), {}, "a-wrong-key-the-service-refuses");
  assert.notEqual(refused.run.status, 0);
});

test("REPORT FILE: a destination that cannot take the record is refused before anything is published", async () => {
  const host = makeHost();
  const service = await startService({ spec: packageSpec() });
  try {
    const missing = path.join(host.home, "no-such-dir", "report.json");
    const run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(KEY), "--report-file", missing, ...approvals(packageSpec())]);
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /its directory does not exist/);
    assert.equal(host.registryBytes().length, 0, "nothing was published");
    assert.deepEqual(host.refs(), [], "no key was stored");
  } finally {
    await service.close();
  }
});

test("REPORT FILE: a record that cannot be written after connect committed keeps the committed outcome", async () => {
  const host = makeHost();
  const service = await startService({ spec: packageSpec() });
  try {
    // A name no filesystem accepts (over 255 characters): it passes the checks before connect, and its write fails after.
    const unwritable = path.join(host.home, `${"r".repeat(300)}.json`);
    const run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(KEY), "--report-file", unwritable, ...approvals(packageSpec())]);
    assert.equal(run.status, 0, `a committed connect is still committed: ${run.stderr}`);
    assert.match(run.stdout, /: committed$/m);
    assert.match(run.stderr, /warning: --report-file .* was not written \(.+\); connect committed regardless/);
    assert.notEqual(host.registryBytes().length, 0, "CONTROL: connect did publish");
  } finally {
    await service.close();
  }
});

test("REPORT FILE: the record's own checks (reportFileProblem, deliverConnectRecord)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-report-"));
  try {
    const file = path.join(dir, "r.json");
    assert.equal(reportFileProblem(file), "", "a fresh path in an existing directory can take the record");
    fs.writeFileSync(path.join(dir, "taken"), "");
    assert.match(reportFileProblem(path.join(dir, "taken")), /exists/);
    assert.match(reportFileProblem(path.join(dir, "gone", "r.json")), /directory does not exist/);
    assert.match(reportFileProblem(path.join(dir, "taken", "r.json")), /directory/, "a parent that is a file cannot take it");
    const report = { result: "committed", service: "svc", installed: [{ id: "a", at: "/p/a" }] };
    // A write that fails after connect committed is a warning that keeps the outcome, never a throw.
    const failing = () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); };
    assert.match(deliverConnectRecord(file, report, failing), /was not written \(ENOSPC\); connect committed regardless/);
    assert.equal(fs.existsSync(file), false);
    const pending = [{ name: "mcp-a", reason: "x", id: "artifact-a", extra: "not in the DTO" }];
    const record = connectRecord({ ...report, pending });
    assert.deepEqual(record, { result: "committed", service: "svc", installed: [{ id: "a", at: "/p/a", reused: false }], pending: [{ name: "mcp-a", reason: "x" }] }, "pending keeps MCP identities/reasons, not artifact ids or arbitrary fields");
    pending[0].reason = "changed later";
    assert.equal(record.pending[0].reason, "x", "the record must snapshot rows rather than retain mutable input objects");
    assert.equal(deliverConnectRecord(file, report), "");
    assert.throws(() => writeConnectRecord(file, report), { code: "EEXIST" }, "writeConnectRecord never overwrites");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { result: "committed", service: "svc", installed: [{ id: "a", at: "/p/a", reused: false }], pending: [] }, "absent pending is serialized as an explicit empty list");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
