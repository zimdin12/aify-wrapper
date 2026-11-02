// The Windows subset is derived from the test files (scripts/windows-only-tests.mjs). These are the files whose tests
// a Linux run of the suite skipped as Windows-only (2026-11-02), each spelled differently; a pattern that stopped seeing
// one would leave that test running nowhere once the full run moved to Linux.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { windowsOnlyTests } from "../scripts/windows-only-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("windowsOnlyTests holds every file a Linux run skipped as Windows-only, and not a cross-platform file", () => {
  const subset = windowsOnlyTests(ROOT);
  for (const name of [
    "a-hermes-config-change-waits-for-a-quiet-host", // platform !== "win32" in the skip
    "claude-aify-takes-the-channel-plugin-route-when-it-is-ready", // ONLY_WINDOWS
    "install-does-not-rely-on-msys-argv-conversion", // !isWindows
    "the-suite-runs-in-a-sealed-home", // through a variable
    "connect-registry-and-launchers",
    "hermes-prior-runs",
    "a-denied-channel-policy-write-names-the-elevated-command",
    "path-lookup", // PATHEXT
  ]) assert.ok(subset.includes(`tests/${name}.test.js`), `${name} fell out of the Windows subset`);
  assert.ok(!subset.includes("tests/render.test.js"), "CONTROL: a file with nothing Windows-only is not in it");
});
