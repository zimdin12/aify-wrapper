#!/usr/bin/env node
// Whether a command recognises itself as the program — which decided, for two days, whether two
// installed commands did anything at all.
//
// THE DEFECT, measured on this host with the package linked globally. Both bins guarded their entry
// point by comparing `import.meta.url` to `pathToFileURL(process.argv[1])`, so that importing them
// from a test stays inert. npm installs its bins as SYMLINKS, so:
//
//   argv[1]      C:\nvm4w\nodejs\node_modules\aify-wrapper\bin\herdr-aify.mjs   (the symlink)
//   import.meta  file:///C:/Users/Administrator/projects/aify-wrapper/bin/...   (the real path)
//
// never matched. `herdr-aify --help` exited 0 and printed NOTHING: on PATH, running, doing nothing.
// An installed command that fails by being silent is the hardest kind to notice, and the docs told
// the operator to run it.
//
// THE TEST THAT WOULD HAVE CAUGHT IT is the last one here: run the real bin through a real symlink.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { isMainModule } from "../lib/main-module.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a script invoked by its own path is the main module", () => {
  const real = path.join(REPO, "bin", "herdr-aify.mjs");
  assert.equal(isMainModule(pathToFileURL(real).href, { argv: ["node", real] }), true);
});

test("a script reached through a SYMLINK is still the main module", () => {
  // The npm-link case, which is how this package is installed on this machine.
  const real = path.join(REPO, "bin", "herdr-aify.mjs");
  const io = {
    realpathSync: given => (given === "/somewhere/link.mjs" ? real : given),
  };
  assert.equal(
    isMainModule(pathToFileURL(real).href, { argv: ["node", "/somewhere/link.mjs"], io }),
    true,
    "a symlinked bin did not recognise itself, so the command would run and do nothing",
  );
});

test("a DIFFERENT script is not the main module, so importing stays inert", () => {
  // The property the guard exists for: a test importing these modules must not start a Herdr.
  const real = path.join(REPO, "bin", "herdr-aify.mjs");
  const other = path.join(REPO, "bin", "aify-herdr-pane.mjs");
  assert.equal(isMainModule(pathToFileURL(real).href, { argv: ["node", other] }), false);
  // And a realpath that resolves somewhere else must not match either.
  const io = { realpathSync: () => other };
  assert.equal(isMainModule(pathToFileURL(real).href, { argv: ["node", "/link"], io }), false);
});

test("no entry script, or an unresolvable one, is not main", () => {
  assert.equal(isMainModule("file:///x.mjs", { argv: ["node"] }), false);
  assert.equal(isMainModule(undefined, { argv: ["node", "/x.mjs"] }), false);
  // A realpath that throws must not crash the guard — it falls back to the raw path.
  const io = {
    realpathSync: () => {
      throw new Error("ENOENT");
    },
  };
  assert.equal(isMainModule(pathToFileURL("/x.mjs").href, { argv: ["node", "/x.mjs"], io }), true);
});

test("the REAL bins actually produce output when reached through a symlink", () => {
  // THE END-TO-END FORM OF THE DEFECT, and the only shape that would have caught it: a unit test of
  // the guard proves the guard, while what broke was the command. This runs the real files the way
  // npm runs them.
  let linkDir;
  try {
    linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-binlink-"));
    fs.symlinkSync(path.join(REPO, "bin"), path.join(linkDir, "bin"), "junction");
  } catch {
    // Symlink creation needs a privilege this host may not grant; skipping is honest, and the
    // pure-function tests above still judge the logic.
    return;
  }
  for (const [name, expected] of [["herdr-aify.mjs", /usage: herdr-aify/], ["aify-herdr-pane.mjs", /usage: aify-herdr-pane/]]) {
    const viaLink = path.join(linkDir, "bin", name);
    const result = spawnSync(process.execPath, [viaLink, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name} exited ${result.status}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      expected,
      `${name} printed nothing when run through a symlink — it is installed and inert`,
    );
  }
  fs.rmSync(linkDir, { recursive: true, force: true });
});
