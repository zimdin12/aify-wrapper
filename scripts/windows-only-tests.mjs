#!/usr/bin/env node
// The test files Windows must still run itself once the full run is on Linux (scripts/test-linux.sh): every file holding
// a test that skips off Windows, and every file about what only Windows has (.cmd shims, PATHEXT lookup). Derived from
// the files, so a Windows-only test added later joins the subset without anyone listing it.
//
//   node scripts/windows-only-tests.mjs            prints the files, one per line
//   npm test -- $(node scripts/windows-only-tests.mjs)
//
// Windows still runs every launcher path in the full run whenever one is asked for; this subset is the floor that
// keeps the Windows-only branches exercised on the platform they exist for.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Not Windows", in the spellings this suite uses: a skip's own condition (`!isWindows`, `ONLY_WINDOWS`), or a
 * `platform !== "win32"` anywhere, since a skip often reads it through a variable (the sealed-home file's mixed case).
 */
const SKIPS_OFF_WINDOWS = /platform\s*!==\s*["']win32["']|skip:\s*[^,}]*(!\s*isWindows\b|ONLY_WINDOWS\b)/;
/** What exists only on Windows: the .cmd shims npm and the installer write, and PATHEXT-driven lookup. */
const WINDOWS_ONLY_SUBJECT = /\.cmd\b|PATHEXT/;

export function windowsOnlyTests(root) {
  const dir = path.join(root, "tests");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort()
    .filter((name) => {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      return SKIPS_OFF_WINDOWS.test(text) || WINDOWS_ONLY_SUBJECT.test(text);
    })
    .map((name) => `tests/${name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${windowsOnlyTests(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")).join("\n")}\n`);
}
