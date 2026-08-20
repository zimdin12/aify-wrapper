// Updating means re-running the installer, and until now that meant remembering the endpoint you
// used the first time. `--endpoint` is required and the script refuses to guess -- correct for a
// FIRST install, where guessing an address is how an agent ends up talking to the wrong service.
//
// A reinstall is not a first install. The endpoint is already baked into the launcher sitting in
// --dest, so it can be read rather than asked for. Read, never executed: running a launcher to ask
// it something starts a runtime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { endpointInFile, endpointInstalledAt } from "../lib/installed-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const KNOWN = "http://10.11.12.13:8800";

const posix = (p) => p.split(String.fromCharCode(92)).join("/");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-reinstall-"));
}

function install(dest, args) {
  return spawnSync("bash", [INSTALL, "--client", "claude", "--dest", posix(dest), ...args], {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, AIFY_NO_PROMPT: "1" },
  });
}

test("reads the endpoint back out of an installed launcher", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);
  assert.equal(endpointInstalledAt(dest), KNOWN);
});

test("an empty destination has no endpoint to recover, and says so as null", () => {
  assert.equal(endpointInstalledAt(tmp()), null);
  assert.equal(endpointInstalledAt(path.join(tmp(), "does-not-exist")), null);
});

test("a template is not an installed launcher", () => {
  // The placeholder must never come back as if it were an address: bake it and the next launcher
  // carries the literal text `@@ENDPOINT@@` where a URL belongs.
  const template = path.join(ROOT, "wrappers", "claude-aify.sh.in");
  assert.equal(endpointInFile(template), null);

  const dest = tmp();
  fs.copyFileSync(template, path.join(dest, "claude-aify"));
  assert.equal(endpointInstalledAt(dest), null);
});

test("a single file answers for itself, and absence is null rather than a throw", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);
  assert.equal(endpointInFile(path.join(dest, "claude-aify")), KNOWN);

  assert.equal(endpointInFile(path.join(dest, "codex-aify")), null, "not installed here");
  assert.equal(endpointInFile(dest), null, "a directory is not a launcher");
  fs.writeFileSync(path.join(dest, "empty-aify"), "");
  assert.equal(endpointInFile(path.join(dest, "empty-aify")), null, "no marker, no answer");
});

test("reinstalling without --endpoint keeps the endpoint that was already there", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);

  const again = install(dest, []);
  assert.equal(again.status, 0, `reinstall should succeed: ${again.stdout}\n${again.stderr}`);
  assert.match(again.stderr + again.stdout, /10\.11\.12\.13/,
    "it must say which endpoint it reused rather than reusing one silently");
  assert.equal(endpointInstalledAt(dest), KNOWN);
});

test("a FIRST install with no endpoint is still refused", () => {
  const first = install(tmp(), []);
  assert.equal(first.status, 78, "nothing installed there, so there is nothing to recover");
  assert.match(first.stderr, /--endpoint is required/);
});

test("an explicit --endpoint still wins over what is installed", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);
  assert.equal(install(dest, ["--endpoint", "http://127.0.0.2:1"]).status, 0);
  assert.equal(endpointInstalledAt(dest), "http://127.0.0.2:1");
});
