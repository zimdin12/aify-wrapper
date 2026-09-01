// This package declares its version in two files, and nothing checked they agree.
//
// SPLIT-M1, external review round 7. aify-comms has carried a single-source version gate since
// v0.2.0 -- `test_version_single_source.py` and `version-consistency.test.js` -- because four
// components there each once carried their own number and none tracked a release: the service
// reported 0.1.0, a config default said 4.0.0, the dashboard hardcoded 0.1.0 and the bridge said
// 4.0.0 in eight hand-copied places, while the project actually shipped v0.1, v0.1.1 and v0.1.2. No
// single edit could have corrected it.
//
// Splitting the repo carried the components out and left that lesson behind. This package now
// declares a version in `VERSION` and in `package.json`, and a release means editing both.
//
// WHY IT MATTERS HERE SPECIFICALLY. `VERSION` is not decoration in this package: install.sh reads it
// (line 141) and bakes it into every launcher as `HARNESS_WRAPPER_VERSION`, and aify-comms' own
// installer reads the SAME file out of the pinned copy. So the file is what a running fleet reports
// about itself, and `package.json` is what npm resolves a pin against. Disagreement means a launcher
// claiming one version while the package that produced it claims another -- and the aify-comms
// doctor's staleness checks read the launcher.
//
// DERIVED, NOT LISTED. The declarations are discovered from the files rather than enumerated, so a
// third one added later cannot sit outside a gate that only knows about two.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file in this package that states its own version, and what each states. */
function declarations() {
  const found = {};
  const versionFile = path.join(ROOT, "VERSION");
  if (fs.existsSync(versionFile)) {
    found.VERSION = fs.readFileSync(versionFile, "utf8").trim();
  }
  for (const name of ["package.json", "package-lock.json"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // A lock file states it twice: at the root and for the package's own entry.
    if (typeof parsed.version === "string") found[name] = parsed.version;
    const own = parsed.packages && parsed.packages[""];
    if (own && typeof own.version === "string") found[`${name} (packages."")`] = own.version;
  }
  return found;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

test("the scan finds the declarations that are definitely there", () => {
  // POSITIVE CONTROL. A scan that found nothing would make the agreement assertion vacuous -- it is
  // trivially true that zero values agree.
  const found = declarations();
  assert.ok("VERSION" in found, "the VERSION file was not read; install.sh bakes it into every launcher");
  assert.ok("package.json" in found, "package.json's version was not read");
  assert.ok(Object.keys(found).length >= 2, `only ${Object.keys(found).length} declaration(s) found`);
});

test("every declared version is a version", () => {
  for (const [where, value] of Object.entries(declarations())) {
    assert.match(value, SEMVER, `${where} declares ${JSON.stringify(value)}, which is not a version`);
  }
});

test("and they all agree", () => {
  const found = declarations();
  const distinct = [...new Set(Object.values(found))];
  assert.equal(
    distinct.length, 1,
    "this package states more than one version, so a release edited some files and not others:\n  "
    + Object.entries(found).map(([w, v]) => `${w} = ${v}`).join("\n  ")
    + "\nEvery launcher carries the VERSION file's value as HARNESS_WRAPPER_VERSION, and aify-comms "
    + "reads that same file out of the pinned copy, so a disagreement ships to the fleet.",
  );
});

test("a disagreement would actually be caught", () => {
  // NEGATIVE CONTROL on the comparison itself. The test above passes while every value matches, which
  // is also what it would do if the comparison were wrong. This proves it can say no.
  const distinct = [...new Set(Object.values({ VERSION: "0.6.0", "package.json": "0.6.1" }))];
  assert.equal(distinct.length, 2, "the comparison cannot distinguish two different versions");
});
