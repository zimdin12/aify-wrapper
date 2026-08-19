#!/usr/bin/env node
// `--all`: install a launcher for every harness present, and NAME every one you skipped.
//
// The failure this guards is a silent partial install. A host with three runtimes where the installer
// finds two produces two working launchers and one missing command, and nothing in the output says
// which — so the operator discovers it at the moment they try to start an agent with the third.
//
// PATH is sealed to a directory this test builds. Without that, the suite would measure whichever
// coding-agent CLIs the developer happens to have, and pass or fail for reasons unrelated to the code.
// The seal carries exactly three things: stub runtimes we placed, a `node` shim (the detector runs
// under node), and the directory holding bash (install.sh shells out to render.sh).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");

/** Set, and reachable by nothing: a wrapper under test must never find a real service. */
const NOWHERE = "http://127.0.0.2:1";

const WIN = process.platform === "win32";
const PATH_SEP = WIN ? ";" : ":";

/** Where bash lives, in the form this platform's PATH wants. Needed because install.sh runs render.sh. */
function bashDir() {
  const posix = execFileSync("bash", ["-c", "dirname \"$(command -v bash)\""], { encoding: "utf8" }).trim();
  if (!WIN) return posix;
  return execFileSync("bash", ["-c", `cygpath -w "${posix}"`], { encoding: "utf8" }).trim();
}

/**
 * A sealed workspace: a PATH containing only a node shim, bash, and whichever stub runtimes are asked
 * for. Returns the directories and the PATH string to run with.
 */
function sealed(runtimes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-all-"));
  const stubs = path.join(dir, "stubs");
  const out = path.join(dir, "out");
  fs.mkdirSync(stubs, { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  // A shim rather than node's own directory, because that directory also holds real runtimes on this
  // machine — including one of the four. Borrowing it would silently un-seal the test.
  const nodeReal = process.execPath;
  fs.writeFileSync(path.join(stubs, "node"), `#!/bin/sh\nexec "${nodeReal.replace(/\\/g, "/")}" "$@"\n`);
  fs.chmodSync(path.join(stubs, "node"), 0o755);

  for (const runtime of runtimes) {
    fs.writeFileSync(path.join(stubs, runtime), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(stubs, runtime), 0o755);
  }

  const stubsForPath = WIN
    ? execFileSync("bash", ["-c", `cygpath -w "${stubs.replace(/\\/g, "/")}"`], { encoding: "utf8" }).trim()
    : stubs;

  return { dir, stubs, out, PATH: [stubsForPath, bashDir()].join(PATH_SEP) };
}

function runInstall({ PATH: sealedPath, args }) {
  return spawnSync("bash", [INSTALL, ...args], {
    encoding: "utf8",
    env: { PATH: sealedPath, HOME: os.tmpdir().replace(/\\/g, "/") },
    timeout: 120_000,
  });
}

test("SEAL CONTROL: with no stub runtimes, nothing is found", () => {
  // The negative control. Every assertion below rests on the seal actually excluding this machine's
  // real claude, codex and hermes — and a seal that leaked would make the skip assertions vacuous.
  const { dir, PATH: p, out } = sealed([]);
  const res = runInstall({ PATH: p, args: ["--all", "--endpoint", NOWHERE, "--render-only", out] });
  assert.equal(res.status, 127, `expected 127, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  for (const client of ["claude", "codex", "hermes", "pi"]) {
    assert.match(res.stdout, new RegExp(`skipped ${client}:`), `${client} was not named as skipped`);
  }
  assert.deepEqual(fs.readdirSync(out), [], "nothing may be written when nothing is installable");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("SEAL CONTROL: with a stub runtime, it IS found", () => {
  // The positive control. A probe that cannot return FOUND cannot be trusted when it returns MISSING.
  const { dir, PATH: p, out } = sealed(["claude"]);
  const res = runInstall({ PATH: p, args: ["--all", "--endpoint", NOWHERE, "--render-only", out] });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.ok(fs.existsSync(path.join(out, "claude-aify")), "claude-aify was not written");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installs one launcher per runtime present, and names every runtime absent", () => {
  const { dir, PATH: p, out } = sealed(["claude", "pi"]);
  const res = runInstall({ PATH: p, args: ["--all", "--endpoint", NOWHERE, "--render-only", out] });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);

  const written = fs.readdirSync(out).sort();
  assert.deepEqual(written, ["claude-aify", "omp-aify", "pi-aify"], "wrong launcher set");

  for (const absent of ["codex", "hermes"]) {
    assert.match(res.stdout, new RegExp(`skipped ${absent}:`), `${absent} was skipped in silence`);
  }
  for (const present of ["claude", "pi"]) {
    assert.doesNotMatch(res.stdout, new RegExp(`skipped ${present}:`), `${present} was installed AND reported skipped`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every launcher --all writes is valid bash carrying no placeholder", () => {
  // --all renders through the same path as --client, and this is the assertion that would catch it
  // diverging: a per-client value leaking across clients shows up as an unsubstituted token.
  const { dir, PATH: p, out } = sealed(["claude", "hermes", "pi"]);
  const res = runInstall({ PATH: p, args: ["--all", "--endpoint", NOWHERE, "--render-only", out] });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  for (const name of fs.readdirSync(out)) {
    const file = path.join(out, name);
    assert.equal(spawnSync("bash", ["-n", file], { encoding: "utf8" }).status, 0, `bash -n failed: ${name}`);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /@@[A-Z_]+@@/, `unsubstituted placeholder in ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hermes' computed extras do NOT leak into another client's launcher", () => {
  // Under --client each run was a fresh process, so per-client extras could not cross. Under --all
  // they share one, and hermes is the only client that appends any.
  const { dir, PATH: p, out } = sealed(["hermes", "pi"]);
  runInstall({ PATH: p, args: ["--all", "--endpoint", NOWHERE, "--render-only", out] });
  const pi = fs.readFileSync(path.join(out, "pi-aify"), "utf8");
  assert.doesNotMatch(pi, /hermes-aify-plugin/, "a hermes-only value reached the pi launcher");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--all and --client together are refused rather than silently preferring one", () => {
  const { dir, PATH: p, out } = sealed(["claude"]);
  const res = runInstall({ PATH: p, args: ["--all", "--client", "claude", "--endpoint", NOWHERE, "--render-only", out] });
  assert.equal(res.status, 78);
  assert.match(res.stderr, /mutually exclusive/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--all still requires an endpoint, and will not guess one", () => {
  const { dir, PATH: p, out } = sealed(["claude"]);
  const res = runInstall({ PATH: p, args: ["--all", "--render-only", out] });
  assert.equal(res.status, 78);
  assert.deepEqual(fs.readdirSync(out), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--render-only writes ONLY into the directory it was given", () => {
  // The property that lets this suite run on a machine with a live fleet: rendering must not reach
  // ~/.local/bin, register an MCP server, or mutate any environment.
  const { dir, PATH: p, out } = sealed(["claude", "codex"]);
  const localBin = path.join(dir, "home", ".local", "bin");
  const res = runInstall({ PATH: p, args: ["--all", "--endpoint", NOWHERE, "--render-only", out] });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(fs.existsSync(localBin), false, "--render-only reached a real install directory");
  assert.deepEqual(fs.readdirSync(out).sort(), ["claude-aify", "codex-aify"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
