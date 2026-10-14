#!/usr/bin/env node
// A launcher finds this package's own bin/ and lib/ in the wrapper directory, never through a service's bridge.
//
// THE BOUNDARY: aify-wrapper must not know anything about a specific service, and its launchers arrive with
// the client path by construction. Until 0.9.7 every template reached its own helpers as
// `@@BRIDGE_DIR@@/node_modules/aify-wrapper/bin/...`, i.e. through the copy of this package that aify-comms'
// bridge happened to install, so a launcher worked only on a host where that service had installed it.
//
// DERIVED, NOT LISTED: the templates are every file in wrappers/, the sourced helpers every .sh in bin/, and
// the package files a template may name are whatever bin/ and lib/ hold now. Whole-line comments are skipped:
// prose may tell the history; code may not repeat it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THROUGH_A_BRIDGE = /node_modules\/aify-wrapper\b/;
// What may stand in front of `/bin/<file>` or `/lib/<file>` in a template: the wrapper root, rendered or
// converted, or a printf slot whose line hands it the converted root.
const WRAPPER_ROOT = /(?:@@WRAPPER_DIR@@|\$\{?AIFY_WRAPPER_DIR_FWD\}?|%s)$/;

const listed = (dir, keep) => fs.readdirSync(path.join(ROOT, dir)).filter(keep).map((name) => `${dir}/${name}`);
const SCANNED = [...listed("wrappers", (n) => n.endsWith(".sh.in")), ...listed("bin", (n) => n.endsWith(".sh"))];
const PACKAGE_FILES = new Set([...listed("bin", () => true), ...listed("lib", () => true)]);

/** The code lines of `text`, numbered from 1, with whole-line comments and `#|` template docs left out. */
function codeLines(text) {
  return text.split("\n").map((line, i) => ({ n: i + 1, line })).filter(({ line }) => !/^\s*#/.test(line));
}

/** Every place in `text` that names this package's files some way other than through the wrapper root. */
function strayReferences(text) {
  const found = [];
  for (const { n, line } of codeLines(text)) {
    if (THROUGH_A_BRIDGE.test(line)) { found.push(`${n}: ${line.trim()}`); continue; }
    for (const m of line.matchAll(/([^\s"'(=]*)\/((?:bin|lib)\/[\w.-]+)/g)) {
      if (!PACKAGE_FILES.has(m[2])) continue;
      const viaRoot = WRAPPER_ROOT.test(m[1]) && (m[1] !== "%s" || /AIFY_WRAPPER_DIR_FWD/.test(line));
      if (!viaRoot) found.push(`${n}: ${line.trim()}`);
    }
  }
  return found;
}

test("the scan reads every template and the sourced helpers, and sees the wrapper root in use", () => {
  for (const client of ["claude", "codex", "hermes", "pi"]) {
    assert.ok(SCANNED.includes(`wrappers/${client}-aify.sh.in`), `${client} template not scanned: ${SCANNED}`);
  }
  assert.ok(SCANNED.includes("bin/aify-lease.sh") && SCANNED.includes("bin/aify-lifetime.sh"), `helpers not scanned: ${SCANNED}`);
  // POSITIVE CONTROL: a scan that read nothing would also find nothing stray.
  const named = SCANNED.flatMap((f) => [...fs.readFileSync(path.join(ROOT, f), "utf8").matchAll(/@@WRAPPER_DIR@@\/bin\/[\w.-]+/g)]);
  assert.ok(named.length >= 8, `only ${named.length} wrapper-root references found; the scan is not reading the templates`);
});

test("NEGATIVE CONTROL: the detector names each way a template used to reach its helpers through the bridge", () => {
  for (const line of [
    'AIFY_LEASE_SH="@@BRIDGE_DIR@@/node_modules/aify-wrapper/bin/aify-lease.sh"',
    '  local _reader="$AIFY_BRIDGE_DIR_FWD/node_modules/aify-wrapper/bin/aify-definition.mjs"',
    '  AIFY_HERDR_HELPER="$AIFY_HERDR_BRIDGE/node_modules/aify-wrapper/bin/aify-herdr-pane.mjs"',
    "  printf 'sh \\\"%s/bin/aify-herdr-state.sh\\\"' \"$AIFY_BRIDGE_DIR_FWD\"",
    '  export AIFY_HERDR_HERMES_PLUGIN="@@NATIVE_BASE@@/lib/hermes-herdr-state.py"',
  ]) {
    assert.equal(strayReferences(line).length, 1, `not caught: ${line}`);
  }
  assert.deepEqual(strayReferences('  node "$AIFY_BRIDGE_DIR_FWD/agent-for-handle.mjs"'), [], "the service's own bridge code is the bridge's to name");
  assert.deepEqual(strayReferences('AIFY_LEASE_SH="@@WRAPPER_DIR@@/bin/aify-lease.sh"'), [], "the wrapper root is the allowed form");
});

test("THE GATE: no template or sourced helper names this package's files except through the wrapper root", () => {
  const stray = SCANNED.flatMap((file) => strayReferences(fs.readFileSync(path.join(ROOT, file), "utf8")).map((at) => `${file}:${at}`));
  assert.deepEqual(stray, [], `reached through something other than @@WRAPPER_DIR@@:\n${stray.join("\n")}`);
});
