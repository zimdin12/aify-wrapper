// A launcher REPORTS its state; it does not host a doctor.
//
// `HARNESS_WRAPPER_VERSION` and `HARNESS_REGISTRY_FINGERPRINT` were shell locals: printed by `--check`,
// baked into the file, and reachable no other way. So "which launcher started this session, and which
// registry was it built against" could only be answered by opening the file on the host -- which is
// why aify-comms carries a host-side staleness check at all.
//
// Exported, they travel into the runtime, the bridge can send them at registration, and the service
// can answer the question from inside the container. That is the whole prerequisite for the command
// surface collapsing to `aify-env` plus the launchers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "wrappers");

const templates = () => fs.readdirSync(TEMPLATES).filter((n) => n.endsWith(".sh.in"));

/** Names this template exports into the runtime's environment. */
function exportsOf(text) {
  return new Set([...text.matchAll(/^[ \t]*export[ \t]+([A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

test("the scan sees the templates and the exports it claims to", () => {
  const names = templates();
  assert.ok(names.length >= 4, `implausibly few templates: ${names}`);
  const claude = fs.readFileSync(path.join(TEMPLATES, "claude-aify.sh.in"), "utf8");
  const found = exportsOf(claude);
  assert.ok(found.has("AIFY_RUNTIME"), "a known export is missing — the scan is broken");
  assert.equal(found.has("AIFY_NOT_A_REAL_NAME"), false, "the scan must be able to say no");
});

test("every launcher exports the version it was built from", () => {
  const missing = templates().filter(
    (n) => !exportsOf(fs.readFileSync(path.join(TEMPLATES, n), "utf8")).has("HARNESS_WRAPPER_VERSION"),
  );
  assert.deepEqual(missing, [], (
    `these keep their version as a shell local, so the only way to learn it is to open the file: ${missing}`
  ));
});

test("every launcher exports the registry fingerprint it was built against", () => {
  const missing = templates().filter(
    (n) => !exportsOf(fs.readFileSync(path.join(TEMPLATES, n), "utf8")).has("HARNESS_REGISTRY_FINGERPRINT"),
  );
  assert.deepEqual(missing, [], `these cannot report which registry they were built against: ${missing}`);
});

test("the exported value is the SAME variable --check prints, not a second copy", () => {
  // Two sources for one fact is how they drift. The export must reference the assignment, not repeat
  // the placeholder.
  for (const name of templates()) {
    const text = fs.readFileSync(path.join(TEMPLATES, name), "utf8");
    assert.match(text, /^[ \t]*export[ \t]+HARNESS_WRAPPER_VERSION="\$HARNESS_WRAPPER_VERSION"$/m,
      `${name} must export the variable it already set, not a second literal`);
    assert.match(text, /^[ \t]*export[ \t]+HARNESS_REGISTRY_FINGERPRINT="\$HARNESS_REGISTRY_FINGERPRINT"$/m,
      `${name} must export the fingerprint it already set`);
  }
});
