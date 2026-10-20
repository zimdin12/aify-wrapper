// A spec's `fixed` is copied into the published entry, so a field is admitted only when a reader validates it
// (S1 "Fields the parser ignores keep their owner's validation"; S1c review R2). The readers are this package's
// parseRegistry (READ_FIELDS) and aify-env's readServices (ENV_READ_FIELDS). Both lists are held here to the reads
// in their owners' source, so a reader that starts or stops reading a field fails this file, not a host.
//
// The refusal covers what a spec newly supplies. A field already in the published entry is the operator's, and a
// reconnect keeps it byte for byte (connect-entry.mjs, RAW PRESERVATION).
//
// THE SIBLING CHECKOUT for the aify-env half: `AIFY_ENV_REPO`, else beside this checkout, else ~/projects/aify-env.
// With none it SKIPS BY NAME: a cross-repo proof that ran nothing must not read as a pass.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { READ_FIELDS } from "../lib/registry.mjs";
import { ENV_READ_FIELDS, validateSpec } from "../lib/service-spec.mjs";
import { KEY, ROOT, makeHost, runConnect, startService, storeCredential } from "./connect-fixture.mjs";

const target = { name: "aify-dashboard", endpoint: "http://127.0.0.1:9700" };

function pendingSpec(fixed) {
  return {
    specVersion: 1,
    name: "aify-dashboard",
    fixed,
    artifacts: [{ id: "dashboard-bridge", kind: "package", source: { pending: "not installed" }, entries: ["fixture-bridge"] }],
    mcp: [{ name: "aify-dashboard", artifact: "dashboard-bridge", entry: "fixture-bridge" }],
    secrets: [{ field: "credentialRef", required: true, probe: "api" }],
    verify: { health: { path: "/health" }, probes: { api: { path: "/api/v1/settings/schema", header: "x-api-key" } } },
  };
}

/** The reads `source`'s function `name` makes, by `patterns`: the extractor every assertion below leans on. */
function readsIn(source, name, patterns) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} is not in the source: the extractor has nothing to read`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  return new Set(patterns.flatMap((pattern) => [...body.matchAll(pattern)].map((m) => m[1])));
}

test("VALIDATOR: a fixed field no reader owns is refused; every owned field the frozen shapes use is admitted", () => {
  const unowned = validateSpec(pendingSpec({ advertise: false, unownedOption: { runs: "arbitrary" } }), target);
  assert.equal(unowned.ok, false);
  assert.ok(unowned.errors.some((e) => e.startsWith("fixed.unownedOption has no reader that validates it")), unowned.errors.join("; "));
  const dashboard = { agentState: { path: "/api/v1/agent-state" }, sessionInject: { mcp: true }, advertise: false, turnStart: { path: "/events/turn-start", budgetMs: 800 } };
  const comms = { agentState: { path: "/api/v1/agent-state" }, endpointEnv: ["AIFY_COMMS_URL"], keyEnv: ["AIFY_API_KEY"] };
  for (const fixed of [dashboard, comms, { strictMcp: false, advertisement: { path: "/x" } }]) {
    const judged = validateSpec(pendingSpec(fixed), target);
    assert.equal(judged.ok, true, `${Object.keys(fixed)}: ${judged.errors.join("; ")}`);
  }
});

test("CLI: a new unowned fixed field is refused with nothing written or staged; a raw field the entry already holds survives a reconnect", async () => {
  const host = makeHost();
  const bad = await startService({ spec: pendingSpec({ advertise: false, unownedOption: { runs: "arbitrary" } }) });
  try {
    const run = await runConnect(host, ["aify-dashboard", bad.url, "--key-file", host.keyFile(KEY)]);
    assert.equal(run.status, 78, run.stdout + run.stderr);
    assert.match(run.stderr, /fixed\.unownedOption has no reader that validates it/);
    assert.equal(host.registryBytes().length, 0);
    assert.deepEqual(host.refs(), []);
  } finally {
    await bad.close();
  }

  // The operator's own raw field, already published, is not the spec's to add or remove.
  const kept = makeHost();
  fs.mkdirSync(path.dirname(kept.registry), { recursive: true });
  fs.writeFileSync(kept.registry, `${JSON.stringify({ version: 1, services: { "aify-dashboard": { endpoint: "http://old", credentialRef: "aify-dashboard.key", legacyOption: { kept: true } } } }, null, 2)}\n`);
  storeCredential(kept, "aify-dashboard.key", KEY);
  const good = await startService({ spec: pendingSpec({ advertise: false }) });
  try {
    const run = await runConnect(kept, ["aify-dashboard", good.url]);
    assert.equal(run.status, 0, run.stderr);
    const entry = JSON.parse(kept.registryBytes()).services["aify-dashboard"];
    assert.deepEqual(entry.legacyOption, { kept: true }, "the published raw field survived");
    assert.equal(entry.endpoint, good.url, "CONTROL: the reconnect committed");
  } finally {
    await good.close();
  }
});

test("READ_FIELDS is exactly the entry fields parseRegistry reads", () => {
  const reads = readsIn(fs.readFileSync(path.join(ROOT, "lib", "registry.mjs"), "utf8"), "parseRegistry", [/\bentry\.([A-Za-z]+)\b/g]);
  for (const known of ["endpoint", "sessionInject", "turnStart"]) assert.ok(reads.has(known), `CONTROL: the extractor finds ${known}`);
  assert.deepEqual([...reads].sort(), [...READ_FIELDS].sort());
});

const ENV_SOURCE = path.join("lib", "services.mjs");
const CANDIDATES = [process.env.AIFY_ENV_REPO, path.join(ROOT, "..", "aify-env"), path.join(os.homedir(), "projects", "aify-env")].filter(Boolean);
const ENV_REPO = CANDIDATES.find((dir) => fs.existsSync(path.join(dir, ENV_SOURCE)));
const skip = ENV_REPO ? false : `no aify-env checkout with ${ENV_SOURCE} (looked in ${CANDIDATES.join(", ")}): NOT verified`;

test("ENV_READ_FIELDS: every field aify-env's readServices reads is owned, and every listed field is one it reads", { skip }, () => {
  const reads = readsIn(fs.readFileSync(path.join(ENV_REPO, ENV_SOURCE), "utf8"), "readServices", [
    /parsed\.services\[name\]\?\.([A-Za-z]+)/g,
    /Object\.hasOwn\(parsed\.services\[name\] \?\? \{\}, "([A-Za-z]+)"\)/g,
  ]);
  for (const known of ["endpoint", "advertise", "agentState", "advertisement"]) assert.ok(reads.has(known), `CONTROL: the extractor finds ${known}`);
  const owned = new Set([...READ_FIELDS, ...ENV_READ_FIELDS]);
  assert.deepEqual([...reads].filter((field) => !owned.has(field)), [], "aify-env reads a field no list here owns");
  assert.deepEqual(ENV_READ_FIELDS.filter((field) => !reads.has(field)), [], "a listed aify-env field it no longer reads");
});
