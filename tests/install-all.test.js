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
// under node), and bash with its tools (install.sh shells out to render.sh). It is built by
// `sealed-path.mjs`, which says why bash's own directory cannot simply be put on PATH.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HARNESS_CLIENTS, RUNTIME_COMMANDS, sealedPath } from "./sealed-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");

/** Set, and reachable by nothing: a wrapper under test must never find a real service. */
const NOWHERE = "http://127.0.0.2:1";

/**
 * A sealed workspace: a PATH containing only a node shim, bash, and whichever stub runtimes are asked
 * for. Returns the directories and the PATH string to run with.
 */
function sealed(runtimes) {
  const { dir, stubs, PATH } = sealedPath(runtimes);
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });
  return { dir, stubs, out, PATH };
}

test("SEAL CONTROL: the runtime names the seal keeps out are derived, including an alias", () => {
  // The seal is only as good as the names it excludes, and those are read out of the templates. An
  // extractor that stopped matching would exclude only the client names -- and pi's CLI is `omp`, so
  // a host with omp in its tool directory would leak it while every assertion here stayed green.
  for (const client of HARNESS_CLIENTS) assert.ok(RUNTIME_COMMANDS.includes(client), `${client} is not excluded`);
  assert.ok(RUNTIME_COMMANDS.includes("omp"), `pi's runtime was not read from its template: ${RUNTIME_COMMANDS}`);
  const { dir, PATH: p } = sealed([]);
  const found = spawnSync("bash", ["-c", `for c in ${RUNTIME_COMMANDS.join(" ")}; do command -v "$c"; done; exit 0`], {
    encoding: "utf8", env: { PATH: p },
  });
  assert.equal(found.stdout.trim(), "", `the sealed PATH still resolves a runtime:\n${found.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

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
