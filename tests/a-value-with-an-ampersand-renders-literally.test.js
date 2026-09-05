#!/usr/bin/env node
// A rendered value containing `&` must arrive in the launcher unchanged.
//
// R9-M12, external review 2026-09-06, reproduced before it was fixed. bash 5.2 added
// `patsub_replacement`, ON BY DEFAULT, which makes an unquoted `&` in the replacement half of
// `${var//pat/repl}` expand to whatever the pattern matched. `render.sh` substitutes with parameter
// expansion (deliberately, so a `/` or `|` in a path cannot break it the way sed would), so an
// endpoint carrying a query string came out mangled:
//
//     value:    http://host/p?a=1&b=2
//     rendered: http://host/p?a=1@@ENDPOINT@@b=2
//
// The placeholder survives, so `render.sh`'s own unsubstituted-placeholder check then fires and exits
// 78 blaming the TEMPLATE -- for a value the renderer damaged. A reader following that message goes
// to the wrong file entirely.
//
// THIS RUNS THE REAL SCRIPT. A test that re-implemented the substitution would agree with whatever it
// did, and the bug lives in a shell option, not in the algorithm.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = path.join(ROOT, "render.sh");
const LF = String.fromCharCode(10);
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

/**
 * Render a throwaway template through a COPY of render.sh, in a directory of its own.
 *
 * NOT INTO `wrappers/`. The first version wrote the probe template beside the real launchers,
 * because `render.sh` resolves templates relative to itself. Other tests DERIVE the launcher set by
 * reading that directory, and `node --test` runs files in parallel -- so a fifth template existed
 * for the moment this test held it and nine assertions elsewhere went red. A test that mutates
 * shared state to observe something is a test that breaks its neighbours.
 */
function render(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-render-amp-"));
  const wrappers = path.join(dir, "wrappers");
  fs.mkdirSync(wrappers, { recursive: true });
  fs.copyFileSync(RENDER, path.join(dir, "render.sh"));

  const name = "probe-aify.sh.in";
  fs.writeFileSync(path.join(wrappers, name), [
    "#!/bin/bash",
    "#| throwaway template for a-value-with-an-ampersand-renders-literally.test.js",
    'ENDPOINT="@@ENDPOINT@@"',
    "",
  ].join(LF));

  const out = path.join(dir, "rendered");
  try {
    const result = spawnSync("bash", [posix(path.join(dir, "render.sh")), name, posix(out), `ENDPOINT=${value}`], {
      encoding: "utf8", timeout: 60_000,
    });
    return {
      status: result.status,
      stderr: String(result.stderr || ""),
      text: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("POSITIVE CONTROL: an ordinary value renders", () => {
  // Every assertion below reads "the output contains X", and a render that failed outright produces
  // an empty file for every value -- which would pass nothing and look like the bug.
  const { status, text, stderr } = render("http://127.0.0.1:8800");
  assert.equal(status, 0, stderr);
  assert.match(text, /ENDPOINT="http:\/\/127\.0\.0\.1:8800"/);
});

test("AN ENDPOINT WITH A QUERY STRING IS NOT MANGLED", () => {
  const value = "http://host:8800/p?a=1&b=2";
  const { status, text, stderr } = render(value);
  assert.equal(
    status, 0,
    `render exited ${status}. Before the fix this was 78 with an "unsubstituted placeholders" `
    + `message, blaming the template for a value the renderer had damaged. stderr: ${stderr}`,
  );
  assert.ok(
    text.includes(value),
    `the value did not survive rendering. Rendered line: ${JSON.stringify(text.split(LF).find((l) => l.includes("ENDPOINT")) || "")}`,
  );
  assert.doesNotMatch(text, /@@ENDPOINT@@/, "the placeholder survived, which is the mangling symptom");
});

test("an ampersand alone is enough to show it", () => {
  // The smallest reproduction, so a future failure is unambiguous about the cause.
  const { status, text } = render("a&b");
  assert.equal(status, 0);
  assert.match(text, /ENDPOINT="a&b"/, "`&` expanded to the matched text instead of staying literal");
});
