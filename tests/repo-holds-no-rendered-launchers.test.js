// A rendered launcher is OUTPUT. Three of them were committed here under paths like
// `C\uF03AUsersADMINI~1AppDataLocalTemptmp4kqi49ym/claude-aify` -- a probe handed bash an
// interpolated Windows path, the backslashes were eaten by quote removal, and what should have been
// an absolute temp directory became a relative one inside the repo. `git add -A` then swept it in.
//
// Nothing detected it. The suite was green, the render itself was correct, and the only symptom was
// a directory name that looked like a temp path if you did not read it closely.
//
// Two independent checks, because the two halves fail separately: a path that escaped its temp dir,
// and a file whose CONTENT is a render rather than a template.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKSLASH = String.fromCharCode(92);

const tracked = () => execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" })
  .split(String.fromCharCode(0))
  .filter(Boolean);

/** A path that was meant to be absolute and got flattened into a relative one. */
export function looksLikeAnEscapedAbsolutePath(p) {
  // U+F03A is what Windows substitutes for a colon it cannot store in a filename.
  if (p.includes(String.fromCharCode(0xf03a))) return true;
  if (p.includes(BACKSLASH)) return true;
  return /^[A-Za-z]:/.test(p);
}

/**
 * The same two conditions aify-env's `lib/allowlist.mjs` uses to decide whether a file is a launcher
 * it may run: the marker as a real assignment LINE, and not still holding a `@@PLACEHOLDER@@`.
 * Anchoring is load-bearing -- three test files mention the marker inside JS string literals, and an
 * unanchored `includes()` reads every one of them as a render.
 */
const MARKER_LINE = /^[ 	]*HARNESS_WRAPPER_VERSION[ 	]*=[ 	]*"([^"]*)"[ 	]*$/m;

export function isRenderedLauncher(text) {
  const match = MARKER_LINE.exec(text);
  if (!match) return false;
  return !/^@@[A-Z0-9_]+@@$/.test(match[1]);
}

test("the predicates say no to what belongs here", () => {
  assert.equal(looksLikeAnEscapedAbsolutePath("wrappers/claude-aify.sh.in"), false);
  assert.equal(looksLikeAnEscapedAbsolutePath("tests/render.test.js"), false);
  const template = fs.readFileSync(path.join(ROOT, "wrappers", "claude-aify.sh.in"), "utf8");
  assert.equal(isRenderedLauncher(template), false, "a template must not read as a render");
  for (const name of ["staleness.test.js", "wrapper-check-cli.test.js",
    "rendered-launchers-are-executable-by-aify-env.test.js"]) {
    const source = fs.readFileSync(path.join(ROOT, "tests", name), "utf8");
    assert.equal(isRenderedLauncher(source), false,
      `${name} asserts on the marker; that is not a render`);
  }
  const installer = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
  assert.equal(isRenderedLauncher(installer), false, "the installer renders, it is not a render");
});

test("the predicates say yes to the shapes that were actually committed", () => {
  // The three real paths, verbatim.
  assert.equal(looksLikeAnEscapedAbsolutePath(
    "C" + String.fromCharCode(0xf03a) + "UsersADMINI~1AppDataLocalTemptmp4kqi49ym/claude-aify"), true);
  assert.equal(looksLikeAnEscapedAbsolutePath(
    "C" + String.fromCharCode(0xf03a) + "/Users/ADMINI~1/AppData/Local/Temp/tmp2yeb2bw5/claude-aify"), true);
  assert.equal(looksLikeAnEscapedAbsolutePath("C:/Users/x/out/claude-aify"), true);
  // And a render, built from the template the way install.sh builds one.
  const template = fs.readFileSync(path.join(ROOT, "wrappers", "claude-aify.sh.in"), "utf8");
  assert.equal(isRenderedLauncher(template.split("@@WRAPPER_VERSION@@").join("0.5.7")), true);
});

test("no tracked path escaped its temp directory", () => {
  const strays = tracked().filter(looksLikeAnEscapedAbsolutePath);
  assert.deepEqual(strays, [], `tracked paths that look like flattened absolute paths: ${strays}`);
});

test("no tracked file is a rendered launcher", () => {
  const renders = tracked().filter((p) => {
    const full = path.join(ROOT, p);
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      return false; // binary, or a path this platform cannot open -- the check above owns those
    }
    return isRenderedLauncher(text);
  });
  assert.deepEqual(renders, [], `rendered launchers are output, not source: ${renders}`);
});
