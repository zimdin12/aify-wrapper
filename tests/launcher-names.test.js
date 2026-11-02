// The launcher names are derived from what the package ships: templates sorted, then the aliases file in its order.
// A fixture package, so the rule is judged apart from today's four templates and one alias.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { launcherAliases, launcherNames } from "../lib/launcher-names.mjs";

function fixture(aliases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-launcher-names-"));
  fs.mkdirSync(path.join(root, "wrappers"));
  for (const name of ["zed-aify.sh.in", "alpha-aify.sh.in", "notes.md"]) fs.writeFileSync(path.join(root, "wrappers", name), "");
  if (aliases !== undefined) fs.writeFileSync(path.join(root, "wrappers", "aliases"), aliases);
  return root;
}

test("launcherNames: the templates sorted, then each alias in file order; comments and blank lines are not names", () => {
  const root = fixture("# launcher alias...\r\n\r\nzed-aify zed2-aify zed3-aify\nalpha-aify a2-aify\n");
  assert.deepEqual(launcherNames(root), ["alpha-aify", "zed-aify", "zed2-aify", "zed3-aify", "a2-aify"]);
  assert.deepEqual([...launcherAliases(root)], [["zed-aify", ["zed2-aify", "zed3-aify"]], ["alpha-aify", ["a2-aify"]]]);
});

test("launcherAliases: no aliases file is no aliases, and the templates still name their launchers", () => {
  const root = fixture(undefined);
  assert.deepEqual([...launcherAliases(root)], []);
  assert.deepEqual(launcherNames(root), ["alpha-aify", "zed-aify"]);
});

test("this package's own aliases file names an alias of a launcher it has a template for", () => {
  // CONTROL on the shipped file: an alias whose launcher has no template would be installed by nobody.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const aliases = launcherAliases(root);
  assert.ok(aliases.size > 0, "the shipped aliases file was not read");
  for (const launcher of aliases.keys()) assert.ok(fs.existsSync(path.join(root, "wrappers", `${launcher}.sh.in`)), `${launcher} has no template`);
});
