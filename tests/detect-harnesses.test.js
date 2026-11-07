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

import { harnessClientsFrom, detectHarnesses, whichFrom } from "../lib/detect-harnesses.mjs";

const TEMPLATES = ["claude-aify.sh.in", "codex-aify.sh.in", "hermes-aify.sh.in", "pi-aify.sh.in"];
const SOURCES = {
  claude: "echo \"runtime CLI 'claude' was not found\"",
  codex: "echo \"runtime CLI 'codex' was not found\"",
  hermes: 'HERMES_RUNTIME_COMMAND="${AIFY_HERMES_COMMAND:-${HERMES_COMMAND:-hermes}}"',
  pi: 'PI_RUNTIME_COMMAND="${AIFY_PI_COMMAND:-${PI_COMMAND:-omp}}"',
};
// Existing lookup/order tests keep their property; supplying template text is now required.
const detect = (options) => detectHarnesses({ templates: SOURCES, ...options });

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
  const rows = detect({
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
  detect({
    clients: ["claude"],
    lookup: (cmd) => { asked.push(cmd); return null; },
  });
  assert.deepEqual(asked, ["claude"], "must ask for the runtime, not claude-aify");
});

test("a lookup that throws is treated as NOT FOUND, never as found", () => {
  // Fail closed. A PATH probe that errors tells us nothing, and "nothing" must not install a launcher
  // for a runtime that may not exist.
  const rows = detect({
    clients: harnessClientsFrom(TEMPLATES),
    lookup: () => { throw new Error("PATH exploded"); },
  });
  assert.equal(rows.every((r) => r.found === false), true);
});

test("a lookup returning empty or whitespace is NOT found", () => {
  const rows = detect({ clients: ["claude", "codex"], lookup: (c) => (c === "claude" ? "" : "   ") });
  assert.equal(rows.every((r) => r.found === false), true);
});

test("rows are ordered deterministically regardless of the order asked for", () => {
  const names = (clients) => detect({ clients, lookup: () => null }).map((r) => r.client);
  assert.deepEqual(names(["pi", "claude", "hermes"]), names(["hermes", "pi", "claude"]));
});

test("no clients means no rows, and not an error", () => {
  assert.deepEqual(detect({ clients: [], lookup: () => "/x" }), []);
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

// These explicit command oracles catch client-name probing independently of the shared extractor.
test("Pi probes only omp, keeping its client identity separate", () => {
  const asked = [];
  const [row] = detect({ clients: ["pi"], lookup: (command) => {
    asked.push(command);
    return command === "omp" ? "/owned/omp" : null;
  } });
  assert.deepEqual(asked, ["omp"]);
  assert.deepEqual(row, { client: "pi", command: "omp", found: true, path: "/owned/omp", invalid: false });
});

test("an unrelated pi executable cannot establish an OMP runtime", () => {
  const [row] = detect({ clients: ["pi"], lookup: (command) => command === "pi" ? "/owned/pi" : null });
  assert.equal(row.found, false);
  assert.equal(row.command, "omp");
});

// Each independent invalid input must refuse BEFORE lookup; the other tests supply healthy controls.
for (const [label, source] of Object.entries({
  missing: undefined,
  empty: "",
  unknown: "exec something-dynamic",
  malformed: 'PI_RUNTIME_COMMAND="${BROKEN:-omp}" trailing',
  substitution: 'PI_RUNTIME_COMMAND="$(printf omp)"',
  operator: 'PI_RUNTIME_COMMAND="${OTHER:+omp}"',
  ambiguous: 'PI_RUNTIME_COMMAND="omp"\nOTHER_RUNTIME_COMMAND="other"',
  diagnostics: "runtime CLI 'omp' was not found\nruntime CLI 'other' was not found",
  "invalid assignment with literal diagnostic": 'PI_RUNTIME_COMMAND="$UNKNOWN"\nruntime CLI \'pi\' was not found',
})) {
  test(`invalid runtime default (${label}) never falls back to client lookup`, () => {
    const asked = [];
    const [row] = detectHarnesses({ clients: ["pi"], templates: { pi: source }, lookup: (command) => {
      asked.push(command); return "/owned/pi";
    } });
    assert.deepEqual(asked, [], "invalid derivation must not perform a lookup");
    assert.deepEqual(row, { client: "pi", command: null, found: false, path: null, invalid: true });
  });
}

test("a fifth template derives its nested default without a client map", () => {
  const [row] = detectHarnesses({ clients: ["future"], templates: {
    future: 'FUTURE_RUNTIME_COMMAND="${ONE:-${TWO:-${THREE:-new-cli}}}"',
  }, lookup: (command) => command === "new-cli" ? "/owned/new-cli" : null });
  assert.equal(row.command, "new-cli");
  assert.equal(row.found, true);
});

test("real templates retain the four literal default-command oracles", async () => {
  const { readFileSync } = await import("node:fs");
  const templates = Object.fromEntries(["claude", "codex", "hermes", "pi"].map(client => [client,
    readFileSync(new URL(`../wrappers/${client}-aify.sh.in`, import.meta.url), "utf8"),
  ]));
  const rows = detectHarnesses({ clients: Object.keys(templates), templates, lookup: command => `/owned/${command}` });
  assert.deepEqual(rows.map(({ client, command, found }) => ({ client, command, found })), [
    { client: "claude", command: "claude", found: true },
    { client: "codex", command: "codex", found: true },
    { client: "hermes", command: "hermes", found: true },
    { client: "pi", command: "omp", found: true },
  ]);
});

// ── the PATH probe itself ────────────────────────────────────────────────────────
// Written here rather than shelled out to `command -v` for one reason: the installer must make the
// same decision the tests make. A probe in bash and a decision in JS is two implementations of one
// rule, and the one nobody tests is the one that ships.

test("finds an executable on the first PATH entry that has it", () => {
  const found = whichFrom({
    pathValue: "/a:/b",
    sep: ":",
    pathExt: [""],
    isExecutable: (p) => p === "/b/claude",
  })("claude");
  assert.equal(found, "/b/claude");
});

test("returns null when nothing on PATH has it", () => {
  assert.equal(whichFrom({ pathValue: "/a:/b", sep: ":", pathExt: [""], isExecutable: () => false })("claude"), null);
});

test("an empty PATH finds nothing and does not throw", () => {
  for (const pathValue of ["", undefined, null]) {
    assert.equal(whichFrom({ pathValue, sep: ":", pathExt: [""], isExecutable: () => true })("claude"), null);
  }
});

test("PATHEXT is tried in order, so claude.cmd is found on Windows", () => {
  const found = whichFrom({
    pathValue: "C:\\bin",
    sep: ";",
    pathExt: ["", ".EXE", ".CMD"],
    isExecutable: (p) => p === "C:\\bin\\claude.CMD",
  })("claude");
  assert.equal(found, "C:\\bin\\claude.CMD");
});

test("an isExecutable that throws is NOT FOUND, and does not abort the whole probe", () => {
  // A single unreadable PATH directory must not make every later directory unsearchable.
  const found = whichFrom({
    pathValue: "/bad:/good",
    sep: ":",
    pathExt: [""],
    isExecutable: (p) => { if (p.startsWith("/bad")) throw new Error("EACCES"); return p === "/good/claude"; },
  })("claude");
  assert.equal(found, "/good/claude");
});

test("empty PATH segments are skipped rather than resolving against the cwd", () => {
  // A trailing or doubled separator yields "", and joining that with a name gives a RELATIVE path.
  // Resolving it would make detection depend on where the installer was invoked from.
  const asked = [];
  whichFrom({
    pathValue: ":/b:",
    sep: ":",
    pathExt: [""],
    isExecutable: (p) => { asked.push(p); return false; },
  })("claude");
  assert.deepEqual(asked, ["/b/claude"]);
});
