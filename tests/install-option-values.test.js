// Issue #18: a missing installer word refuses before effects; an explicitly supplied value keeps its meaning.
// Existing install-all/reinstall/reader tests cover those workflows. This file adds the missing-value matrix and
// replays the env chain's option vector with only a scratch --render-only destination added for safety.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sealedPath, withPath } from "./sealed-path.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const posix = (p) => p.split(path.sep).join("/");
// Every current valued parser arm ends in shift 2. The test's expected refusal is independent of its implementation.
const VALUED = [...fs.readFileSync(INSTALL, "utf8").matchAll(/^\s+(--[a-z-]+)\).*shift 2/gm)].map((m) => m[1]);

function fixture(t) {
  const { dir, PATH } = sealedPath(["claude"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const out = path.join(dir, "out");
  fs.mkdirSync(home);
  fs.mkdirSync(out);
  const registry = path.join(dir, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: {} }));
  const env = withPath({ HOME: posix(home), USERPROFILE: home, TMPDIR: dir, TEMP: dir, TMP: dir, AIFY_NO_PROMPT: "1" }, PATH);
  function run(args) {
    return spawnSync("bash", [INSTALL, ...args], { env, cwd: dir, encoding: "utf8", timeout: 120_000 });
  }
  // Actual aify-env bin/aify-env-install.mjs:92 option vector, then the safety-only scratch render destination.
  const args = ["--client", "claude", "--endpoint", NOWHERE, "--registry", posix(registry), "--render-only", posix(out)];
  function rendered() {
    const file = path.join(out, "claude-aify");
    assert.ok(fs.existsSync(file), "a successful installer did not write the expected scratch launcher");
    return fs.readFileSync(file, "utf8");
  }
  return { dir, home, out, registry, run, args, rendered };
}

function unchangedOnRefusal(f, option, args) {
  const previous = Buffer.from("existing launcher must survive");
  const target = path.join(f.out, "claude-aify");
  fs.writeFileSync(target, previous);
  const registry = fs.readFileSync(f.registry);
  const result = f.run(args);
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 78, `expected a configuration refusal for ${option}, not shift/crash: ${diagnostic}`);
  assert.ok(result.stderr.includes(`${option} needs a value`), `wrong missing-value diagnostic: ${diagnostic}`);
  assert.deepEqual(fs.readFileSync(target), previous, "refusal replaced the existing launcher");
  assert.deepEqual(fs.readdirSync(f.out), ["claude-aify"], "refusal partially installed another artifact");
  assert.deepEqual(fs.readFileSync(f.registry), registry, "refusal changed the registry");
  assert.deepEqual(fs.readdirSync(f.home), [], "refusal wrote a default install or profile");
}

test("matrix control: the actual parser's valued options include early and late arms", () => {
  assert.ok(VALUED.includes("--client"));
  assert.ok(VALUED.includes("--service"));
  assert.equal(new Set(VALUED).size, VALUED.length);
});

for (const option of VALUED) {
  test(`${option}: absent value names the option, exits 78 and leaves artifacts unchanged`, (t) => {
    const f = fixture(t);
    unchangedOnRefusal(f, option, [...f.args, option]);
  });
}

for (const option of ["--client", "--endpoint", "--mcp-transport"]) {
  for (const next of ["--client", "--help"]) {
    test(`${option}: following ${next} is not consumed as its value`, (t) => {
      const f = fixture(t);
      unchangedOnRefusal(f, option, [...f.args, option, next]);
    });
  }
}

test("CONTROL: the env chain's valid argv renders only in the supplied scratch destination", (t) => {
  const f = fixture(t);
  const result = f.run(f.args);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.rendered().includes(NOWHERE));
  assert.deepEqual(fs.readdirSync(f.home), [], "render-only reached default installs or profiles");
});

for (const option of ["--bridge-dir", "--native-base", "--wrapper-dir", "--host-repo"]) {
  test(`CONTROL: explicit empty ${option} keeps the default render`, (t) => {
    const f = fixture(t);
    assert.equal(f.run(f.args).status, 0);
    const before = f.rendered();
    const again = f.run([...f.args, option, ""]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(f.rendered(), before, "an explicit empty value changed its prior defaulting");
  });
}

test("CONTROL: dash-prefixed path values and a supplied empty KEY=VALUE are not missing words", (t) => {
  const f = fixture(t);
  const result = f.run([...f.args, "--bridge-dir", "--help", "--host-repo", "-source tree", "--set", "UNUSED="]);
  assert.equal(result.status, 0, result.stderr);
  const text = f.rendered();
  assert.ok(text.includes('AIFY_BRIDGE_DIR_FWD="--help"'), "a path that spells an option was rejected or consumed");
  assert.ok(text.includes("-source tree"), "dash-prefixed host path lost its argument boundary");
});

for (const args of [
  ["--all", "--endpoint", NOWHERE],
  ["--client", "claude", "--endpoint", NOWHERE, "--mcp-transport", "http"],
  ["--client", "claude", "--endpoint", NOWHERE, "--service", "another-service"],
]) {
  test(`CONTROL: documented operator ${args.join(" ")} keeps working`, (t) => {
    const f = fixture(t);
    const result = f.run([...args, "--registry", posix(f.registry), "--render-only", posix(f.out)]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.rendered().includes(NOWHERE));
    assert.deepEqual(fs.readdirSync(f.home), []);
  });
}

test("CONTROL: the documented help command exits without writing", (t) => {
  const f = fixture(t);
  const result = f.run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("--client"));
  assert.deepEqual(fs.readdirSync(f.out), []);
  assert.deepEqual(fs.readdirSync(f.home), []);
});
