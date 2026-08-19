#!/usr/bin/env node
// Which harnesses are on this machine, decided without touching this machine.
//
// The lookup is injected. A test that shells out to `command -v` measures the developer's laptop and
// passes or fails for reasons that have nothing to do with the code — and a suite that reads live
// ambient state is exactly the shape that once had a release gate reading the operator's own hermes
// gateway marker.
//
// The other thing pinned here is subtle and would be easy to get wrong: detection looks for the
// RUNTIME (`claude`), never for the launcher (`claude-aify`). Looking for the launcher would make a
// previously-installed wrapper prove the presence of a harness that may have since been uninstalled,
// so every reinstall would keep reinstalling launchers for runtimes that are gone.

import assert from "node:assert/strict";
import { test } from "node:test";

import { harnessClientsFrom, detectHarnesses } from "../lib/detect-harnesses.mjs";

const TEMPLATES = ["claude-aify.sh.in", "codex-aify.sh.in", "hermes-aify.sh.in", "pi-aify.sh.in"];

test("client names are derived from the template filenames, not hardcoded", () => {
  assert.deepEqual(harnessClientsFrom(TEMPLATES), ["claude", "codex", "hermes", "pi"]);
});

test("a FIFTH template needs no list edited to be installable", () => {
  // The whole point of deriving: adding wrappers/gemini-aify.sh.in makes gemini installable.
  assert.deepEqual(
    harnessClientsFrom([...TEMPLATES, "gemini-aify.sh.in"]),
    ["claude", "codex", "gemini", "hermes", "pi"],
  );
});

test("files that are not wrapper templates are ignored", () => {
  assert.deepEqual(harnessClientsFrom(["README.md", "claude-aify.sh.in", "notes.sh", ".keep"]), ["claude"]);
});

test("returns one row per known harness, found or not", () => {
  const rows = detectHarnesses({
    clients: harnessClientsFrom(TEMPLATES),
    lookup: (cmd) => (cmd === "claude" ? "/usr/bin/claude" : null),
  });
  assert.deepEqual(rows.map((r) => r.client), ["claude", "codex", "hermes", "pi"]);
  assert.equal(rows.find((r) => r.client === "claude").found, true);
  assert.equal(rows.find((r) => r.client === "claude").path, "/usr/bin/claude");
  assert.equal(rows.find((r) => r.client === "codex").found, false);
});

test("detection looks for the RUNTIME, never for the launcher", () => {
  const asked = [];
  detectHarnesses({
    clients: ["claude"],
    lookup: (cmd) => { asked.push(cmd); return null; },
  });
  assert.deepEqual(asked, ["claude"], "must ask for the runtime, not claude-aify");
});

test("a lookup that throws is treated as NOT FOUND, never as found", () => {
  // Fail closed. A PATH probe that errors tells us nothing, and "nothing" must not install a launcher
  // for a runtime that may not exist.
  const rows = detectHarnesses({
    clients: harnessClientsFrom(TEMPLATES),
    lookup: () => { throw new Error("PATH exploded"); },
  });
  assert.equal(rows.every((r) => r.found === false), true);
});

test("a lookup returning empty or whitespace is NOT found", () => {
  const rows = detectHarnesses({ clients: ["claude", "codex"], lookup: (c) => (c === "claude" ? "" : "   ") });
  assert.equal(rows.every((r) => r.found === false), true);
});

test("rows are ordered deterministically regardless of the order asked for", () => {
  const names = (clients) => detectHarnesses({ clients, lookup: () => null }).map((r) => r.client);
  assert.deepEqual(names(["pi", "claude", "hermes"]), names(["hermes", "pi", "claude"]));
});

test("no clients means no rows, and not an error", () => {
  assert.deepEqual(detectHarnesses({ clients: [], lookup: () => "/x" }), []);
});

test("POSITIVE CONTROL: the derivation finds the four launchers actually in wrappers/", async () => {
  // Every assertion above feeds the module a hand-written list. If the real filenames stopped matching
  // the pattern, all of them would still pass while the installer found nothing. A derivation that
  // cannot find what is genuinely on disk is worth nothing.
  const { readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(harnessClientsFrom(readdirSync(join(root, "wrappers"))), ["claude", "codex", "hermes", "pi"]);
});
