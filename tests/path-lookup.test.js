#!/usr/bin/env node
// Whether a bare command name is something the pane's shell could actually run.
//
// WHY IT MATTERS ENOUGH TO TEST. `herdr pane run` answers ok for typing a command, not for running
// one, so this lookup is the only thing between "aify-env is not installed here" and thirty seconds
// of a launcher saying nothing. A lookup that said yes too easily would put the silence back; one
// that said no too easily would refuse a working host, which is worse. Both directions are measured.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveOnPath } from "../lib/path-lookup.mjs";

function dirWith(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-path-"));
  for (const name of names) fs.writeFileSync(path.join(dir, name), "", { mode: 0o755 });
  return dir;
}

test("it finds a name on PATH, and refuses one that is not there", () => {
  const dir = dirWith(["aify-env"]);
  const env = { PATH: `${path.join(dir, "nothing-here")}:${dir}` };

  const found = resolveOnPath("aify-env", { env, platform: "linux" });
  assert.equal(found.ok, true, found.why);
  assert.equal(found.found, path.join(dir, "aify-env"));

  // NEGATIVE CONTROL IN THE SAME RUN: the same PATH, a name that is not on it. A lookup that cannot
  // say no cannot say yes either.
  const missing = resolveOnPath("aify-not-installed", { env, platform: "linux" });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /not on the PATH/);
  assert.ok(missing.tried.length > 0, "a refusal that names nowhere it looked is not a diagnosis");
});

test("A LINK POINTING AT SOMETHING GONE IS NOT INSTALLED — the case this was written for", () => {
  // MEASURED 2026-09-16: a global npm install had linked `aify-env` into a directory a restart took
  // away, so the shim in the PATH directory was a symlink to nothing. A shell will not run it, and
  // neither `ls` nor a name-only check notices.
  const dir = dirWith([]);
  const gone = path.join(dir, "was-here");
  fs.symlinkSync(gone, path.join(dir, "aify-env"));
  const refused = resolveOnPath("aify-env", { env: { PATH: dir }, platform: "linux" });
  assert.equal(refused.ok, false, "a dangling link was taken for an installed binary");

  // POSITIVE CONTROL: the same directory, the same name, once the target exists.
  fs.writeFileSync(gone, "", { mode: 0o755 });
  assert.equal(resolveOnPath("aify-env", { env: { PATH: dir }, platform: "linux" }).ok, true);
});

test("on Windows an npm shim counts, because that is what npm installs", () => {
  const dir = dirWith(["aify-env.cmd"]);
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const found = resolveOnPath("aify-env", { env, platform: "win32" });
  assert.equal(found.ok, true, "the .cmd shim npm writes was not recognised, which refuses a working host");
  assert.equal(found.found, path.join(dir, "aify-env.cmd"));
});

test("a name with a separator is a path, and is checked as one", () => {
  const dir = dirWith(["aify-env"]);
  assert.equal(resolveOnPath(path.join(dir, "aify-env"), { env: { PATH: "" }, platform: "linux" }).ok, true);
  assert.equal(resolveOnPath(path.join(dir, "nope"), { env: { PATH: dir }, platform: "linux" }).ok, false);
});

test("an empty PATH says so, rather than reporting a search it never made", () => {
  const refused = resolveOnPath("aify-env", { env: {}, platform: "linux" });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /PATH is empty/);
});
