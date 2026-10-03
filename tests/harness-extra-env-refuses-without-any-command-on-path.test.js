// HARNESS_EXTRA_ENV refuses the names aify owns even when an earlier line of it has emptied PATH.
//
// The filter upper-cased each name through `tr`. A line `PATH=/nowhere` is an ordinary name, so it was exported,
// and every later line's `tr` was then not found: the conversion came back empty, matched nothing, and the
// protected name was exported (review of 0.8.2, R3). This runs the exact block from each launcher template, as
// that review did, and reads the result with a shell builtin, because PATH is gone by then.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WRAPPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wrappers");

/** The `if [ -n "$HARNESS_EXTRA_ENV" ]; then ... fi` block of one template, verbatim. */
function filterBlock(template) {
  const text = fs.readFileSync(path.join(WRAPPERS, template), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf('if [ -n "$HARNESS_EXTRA_ENV" ]; then');
  assert.ok(start >= 0, `${template} has no HARNESS_EXTRA_ENV block`);
  const end = text.indexOf("\nfi\n", text.indexOf("HARNESS_ENV_EOF\n", start) + 1);
  return text.slice(start, end + 4);
}

const templates = fs.readdirSync(WRAPPERS).filter((name) => name.endsWith("-aify.sh.in"));

test("every launcher template carries the filter this judges", () => {
  assert.deepEqual(templates.sort(), ["claude-aify.sh.in", "codex-aify.sh.in", "hermes-aify.sh.in", "pi-aify.sh.in"]);
});

for (const template of templates) {
  test(`${template}: a protected name stays out after PATH= has removed every command`, () => {
    const script = [
      `HARNESS_EXTRA_ENV="$(printf 'PROVIDER_TOKEN=kept\\nPATH=/nowhere\\nAIFY_MANAGED_MODEL=m-forced\\nharness_role=forced')"`,
      filterBlock(template),
      'printf "%s|%s|%s" "${PROVIDER_TOKEN-unset}" "${AIFY_MANAGED_MODEL-unset}" "${harness_role-unset}"',
    ].join("\n");
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } });
    assert.equal(run.stdout, "kept|unset|unset", `stderr: ${run.stderr}`);
    assert.match(run.stderr, /may not set AIFY_MANAGED_MODEL, which aify owns; skipped/);
    assert.match(run.stderr, /may not set harness_role, which aify owns; skipped/);
  });
}
