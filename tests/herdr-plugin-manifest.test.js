#!/usr/bin/env node
// The plugin manifest points at a script by a RELATIVE path, and nothing else would notice if it
// stopped resolving.
//
// THE FAILURE THIS EXISTS FOR. Herdr runs a plugin command with the plugin directory as its working
// directory and does not put it through a shell, so `["node", "../bin/aify-herdr-pane.mjs"]` is
// resolved against `herdr-plugin/`. Move the script, rename the directory, or drop `herdr-plugin/`
// from the published `files` list, and the manifest still parses, the plugin still links, Herdr
// still starts -- and the restore silently never happens. The operator would find out at the next
// reboot, by an agent not coming back, with nothing anywhere saying why.
//
// SO THE PATHS ARE RESOLVED THE WAY HERDR RESOLVES THEM: from the plugin directory, against the real
// filesystem. This is a cheap test for a failure that is otherwise invisible until a restart.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(REPO, "herdr-plugin");
const MANIFEST = path.join(PLUGIN_DIR, "herdr-plugin.toml");

/** The command arrays, read out of the manifest without adding a TOML dependency for four lines. */
function commands(toml) {
  const found = [];
  for (const match of toml.matchAll(/^command\s*=\s*\[(.+)\]\s*$/gm)) {
    found.push(match[1].split(",").map(part => part.trim().replace(/^"|"$/g, "")));
  }
  return found;
}

test("the manifest exists and declares the startup hook the restore depends on", () => {
  const toml = fs.readFileSync(MANIFEST, "utf8");
  assert.match(toml, /^\[\[startup\]\]$/m, "no [[startup]] table — nothing runs after a session restore");
  assert.match(toml, /^id = "aify\.wrappers"$/m);
  assert.match(toml, /^min_herdr_version = "0\.9\.0"$/m);
});

test("every command in the manifest resolves to a file that exists, from the plugin directory", () => {
  const found = commands(fs.readFileSync(MANIFEST, "utf8"));
  // POSITIVE CONTROL on the reader: a manifest with commands must yield commands, or the loop below
  // would pass by iterating nothing — which is exactly the green that judges nothing.
  assert.ok(found.length >= 3, `expected the manifest's commands to be readable, got ${found.length}`);
  for (const argv of found) {
    assert.equal(argv[0], "node", "a command that is not node would need its own resolution check");
    const script = path.resolve(PLUGIN_DIR, argv[1]);
    assert.ok(fs.existsSync(script), `${argv[1]} does not resolve from the plugin directory (${script})`);
  }
});

test("the plugin directory is published, or an installed package has no plugin to link", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("herdr-plugin/"), "herdr-plugin/ is missing from package.json files");
  assert.ok(pkg.files.includes("bin/"), "bin/ is missing, so the script the manifest names would not ship");
});

test("the reader can say no", () => {
  // Driven by removing what it watches: a manifest with no command lines must yield none, so the
  // 'every command resolves' test above cannot be passing because the regex matches everything.
  assert.deepEqual(commands("id = \"x\"\n[[startup]]\n"), []);
  assert.deepEqual(commands('command = ["node", "a.mjs"]')[0], ["node", "a.mjs"]);
});
