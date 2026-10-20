// An artifact id and a service name become install paths, so neither may choose where connect writes (S1c review
// R1). The spec is unkeyed metadata and an approval binds {kind, repo, entries}, never the id, so an id that walks
// out of its root would install somewhere nobody approved under an approval that still matches.
//
// Two locks, each witnessed: the validator refuses any id that is not one path segment, and every destination is
// settled in prepare by `inside`, which refuses a join that leaves its root. Every CLI case runs with TMPDIR/TEMP/TMP
// inside its own host, so an escape on a broken build still lands in the sandbox.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { inside, Refused } from "../lib/connect.mjs";
import { tupleDigest, validateSpec } from "../lib/service-spec.mjs";
import { KEY, approvals, gitPackage, makeHost, runConnect, startService } from "./connect-fixture.mjs";

const ESCAPE = "../../escaped";
const target = { name: "aify-dashboard", endpoint: "http://127.0.0.1:9700" };

/** The dashboard's shape with one artifact under `id`, from git or served, its server naming the same id. */
function specWith(id, source) {
  return {
    specVersion: 1,
    name: "aify-dashboard",
    fixed: { advertise: false },
    artifacts: [{ id, kind: "package", ...source, entries: ["fixture-bridge"] }],
    mcp: [{ name: "aify-dashboard", artifact: id, entry: "fixture-bridge" }],
    secrets: [{ field: "credentialRef", required: true, probe: "api" }],
    verify: { health: { path: "/health" }, probes: { api: { path: "/api/v1/settings/schema", header: "x-api-key" } } },
  };
}
const fromGit = () => ({ source: { git: { repo: gitPackage().repo, revision: gitPackage().revisions[0] } } });
const BYTES = Buffer.from("served artifact bytes");
const SERVED_PATH = "/.well-known/aify-service/artifacts/bridge.tgz";
const served = () => ({ source: { served: { path: SERVED_PATH, version: "1" } }, sha256: createHash("sha256").update(BYTES).digest("hex") });

/** A host whose temp directories are its own: `t/u` deep, so `../../x` from a temp child still lands inside. */
function sealedHost() {
  const host = makeHost();
  const tmp = path.join(host.home, "t", "u");
  fs.mkdirSync(tmp, { recursive: true });
  return { host, env: { TMPDIR: tmp, TEMP: tmp, TMP: tmp } };
}

async function connectSpec(spec) {
  const { host, env } = sealedHost();
  const service = await startService({
    spec,
    answer: (req, keyed) => (req.url === SERVED_PATH ? (keyed === "right" ? { status: 200, body: BYTES, type: "application/octet-stream" } : { status: 401 }) : null),
  });
  try {
    const run = await runConnect(host, ["aify-dashboard", service.url, "--key-file", host.keyFile(KEY), ...approvals(spec)], { env });
    return { host, run, requests: service.requests };
  } finally {
    await service.close();
  }
}

/** Every file under `dir`, relative, for "nothing landed anywhere it should not". */
function filesUnder(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const d of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(at, d.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out;
}

test("VALIDATOR: an artifact id or service name that is not one path segment is refused; the safe twin passes", () => {
  const safe = validateSpec(specWith("dashboard-bridge", fromGit()), target);
  assert.equal(safe.ok, true, safe.errors.join("; "));
  for (const id of [ESCAPE, "..\\..\\escaped", "..", ".", "a/b", "a\\b", "C:x", "C:\\x", "/abs", "bridge.", ".bridge", "nul", "CON.tgz", "com1", "x".repeat(65), ""]) {
    const judged = validateSpec(specWith(id, fromGit()), target);
    assert.equal(judged.ok, false, `${JSON.stringify(id)} was accepted`);
    assert.ok(judged.errors.some((e) => e.startsWith("artifacts[0].id ")), `${JSON.stringify(id)}: ${judged.errors.join("; ")}`);
  }
  const twins = specWith("Bridge", fromGit());
  twins.artifacts.push({ ...twins.artifacts[0], id: "bridge" });
  assert.ok(validateSpec(twins, target).errors.some((e) => /repeats another id, ignoring case/.test(e)), "two ids one directory apart only in case");
  for (const name of [ESCAPE, "..", "a/b"]) {
    const spec = { ...specWith("dashboard-bridge", fromGit()), name };
    assert.ok(validateSpec(spec, { ...target, name }).errors.some((e) => e.startsWith("the service name ")), `service name ${name}`);
  }
});

test("INSIDE: a join that leaves its root is refused, whatever spelling reaches it; one segment inside returns path.join", () => {
  const root = path.join(path.sep, "aify", "packages");
  assert.equal(inside(root, "aify-dashboard", "dashboard-bridge"), path.join(root, "aify-dashboard", "dashboard-bridge"));
  const escapes = [[ESCAPE], ["aify-dashboard", ESCAPE], [".."], ["."], ["..", "packages-evil", "x"], [path.resolve(path.sep, "elsewhere")]];
  // `D:x` is not here: joined under a root it stays inside (on NTFS a stream name), and the validator refuses colons.
  if (process.platform === "win32") escapes.push(["..\\..\\escaped"], ["D:\\elsewhere"]);
  for (const segments of escapes) {
    assert.throws(() => inside(root, ...segments), (e) => e instanceof Refused && /resolves outside/.test(e.message), JSON.stringify(segments));
  }
});

test("PACKAGE: an id walking out of the package root is refused under an unchanged approval, before any key, npm or write; the safe twin installs inside", async () => {
  const twin = specWith("dashboard-bridge", fromGit());
  const escaping = specWith(ESCAPE, fromGit());
  assert.equal(tupleDigest(escaping.artifacts[0]), tupleDigest(twin.artifacts[0]), "the approval does not see the id: the lock must be elsewhere");

  const bad = await connectSpec(escaping);
  assert.equal(bad.run.status, 78, bad.run.stdout + bad.run.stderr);
  assert.match(bad.run.stderr, /escaped/);
  assert.deepEqual(bad.host.npmCalls(), [], "npm never ran");
  assert.equal(bad.host.registryBytes().length, 0, "nothing was published");
  assert.deepEqual(bad.host.refs(), [], "no key was staged");
  assert.equal(fs.existsSync(path.join(bad.host.home, ".aify", "escaped")), false, "nothing was created where the id pointed");

  const good = await connectSpec(twin);
  assert.equal(good.run.status, 0, good.run.stderr);
  const [install] = good.host.npmCalls().filter((call) => call[0] === "install");
  const prefix = install[install.indexOf("--prefix") + 1];
  const root = path.join(good.host.home, ".aify", "packages", "aify-dashboard", "dashboard-bridge");
  assert.ok(path.resolve(prefix).startsWith(path.resolve(root) + path.sep), `the twin's prefix ${prefix} is inside ${root}`);
});

test("SERVED: an id walking out of the staging directory is refused before the artifact is requested or written; the safe twin is fetched inside", async () => {
  const bad = await connectSpec(specWith(ESCAPE, served()));
  assert.equal(bad.run.status, 78, bad.run.stdout + bad.run.stderr);
  assert.match(bad.run.stderr, /escaped/);
  assert.ok(!bad.requests.some((r) => r.path === SERVED_PATH), "the artifact was never requested");
  assert.equal(bad.host.registryBytes().length, 0);
  assert.deepEqual(bad.host.refs(), []);
  assert.deepEqual(filesUnder(bad.host.home).filter((f) => /escaped/.test(f)), [], "no escaped file anywhere in the sandbox");

  const good = await connectSpec(specWith("served-bridge", served()));
  assert.equal(good.run.status, 0, good.run.stderr);
  const fetched = /fetched and verified: (.+)/.exec(good.run.stdout)?.[1]?.trim();
  assert.ok(fetched, good.run.stdout);
  assert.equal(path.basename(fetched), "served-bridge.tgz");
  assert.ok(path.resolve(fetched).startsWith(path.resolve(good.host.home, "t", "u") + path.sep), `fetched into the sealed temp: ${fetched}`);
  assert.ok(fs.readFileSync(fetched).equals(BYTES));
});
