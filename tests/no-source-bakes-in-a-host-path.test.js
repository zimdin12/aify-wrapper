#!/usr/bin/env node
// No launcher, helper or template decides where something IS from a path typed into it.
//
// THE RULE, from the operator on 2026-09-16: "we should never have C:/ paths. we never know where user
// installs anything. everything should be dynamic in that sense. agent who installs should fill the
// dynamic gaps based on the system, mb C:/ could be as example."
//
// This package is installed by whoever runs `install.sh`, on a host nobody here has seen, so a drive
// letter in its code is a guess about that host. `codexHookTrustKey` was the live case: it built codex'
// synthetic config path from a literal `C:\`, which is the wrong key on a host whose Windows is not on C:.
// It reads the root this process runs on now.
//
// CODE, NOT PROSE. These files explain themselves in comments full of real Windows paths, and that is
// what they are for. Whole-line comments are stripped -- crude on purpose, like aify-comms' `_source.py`:
// a scanner clever enough to need its own tests is the wrong instrument for a gate. An example a person
// reads says `example path` on its line or the line above.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCHED = ["lib", "bin", "wrappers"];
const SUFFIXES = [".mjs", ".js", ".sh", ".in"];
const HOST_PATH = /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/])|(?:\/mnt\/[a-z]\/)/;
const EXAMPLE = "example path";

/** Every file this package ships, minus its tests. */
function shipped() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (SUFFIXES.includes(path.extname(entry.name))) {
        found.push(full);
      }
    }
  };
  for (const dir of SEARCHED) walk(path.join(ROOT, dir));
  return found.sort();
}

/** A line that is nothing but commentary, in JavaScript or in shell. */
const isComment = (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line);

test("no shipped file names a drive or a WSL mount in code", () => {
  const files = shipped();
  assert.ok(files.length > 20, `the walk found ${files.length} files, so it proves almost nothing`);

  const offenders = [];
  const examples = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (isComment(line) || !HOST_PATH.test(line)) return;
      const marked = line.toLowerCase().includes(EXAMPLE) || (index > 0 && lines[index - 1].toLowerCase().includes(EXAMPLE));
      const where = `${path.relative(ROOT, file).split(path.sep).join("/")}:${index + 1}: ${line.trim().slice(0, 120)}`;
      (marked ? examples : offenders).push(where);
    });
  }

  assert.deepEqual(offenders, [], "these decide a location from a path typed into the source; read it from the "
    + `system instead (an environment variable, the root this process runs on, the file's own location), or mark it \`${EXAMPLE}\`:\n  `
    + offenders.join("\n  "));
  // Measured 2026-09-16: none. An example arriving here is a decision, so it raises this number deliberately.
  assert.equal(examples.length, 0, `example paths appeared:\n  ${examples.join("\n  ")}`);
});

test("the scan reads code and not the comment beside it", () => {
  // POSITIVE AND NEGATIVE CONTROL IN ONE RUN: a probe that cannot fail cannot pass.
  for (const prose of ["// a note about C:\\Users\\x", " * bash script as `C:/x`", "# Claude encodes \"C:\\Docker\\foo\""]) {
    assert.ok(isComment(prose), `commentary read as code: ${prose}`);
  }
  for (const code of ['const root = "C:/x";', 'AIFY_HOME=C:/Users/x', 'return "/mnt/c/Docker";']) {
    assert.ok(!isComment(code) && HOST_PATH.test(code), `real code was not searched: ${code}`);
  }
  for (const innocent of ["http://localhost:8800", "wss://host/ws", "a ratio of 1:2", "10:30"]) {
    assert.ok(!HOST_PATH.test(innocent), `${innocent} is not a host path`);
  }
  // AND THE ONE IT CANNOT TELL APART: a bare `a:/` in prose reads as a drive. It is a code line's own
  // problem to avoid, and the marker is there for the rest.
  assert.ok(HOST_PATH.test("mount a:/data"), "the drive rule is deliberately literal");
});
