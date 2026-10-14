#!/usr/bin/env node
// The wrapper directory a launcher is rendered with is an ABSOLUTE path, whatever the installer was handed.
//
// A launcher finds its definition reader, lease and session helpers under @@WRAPPER_DIR@@. Review of 0.9.7
// (slice c): `--wrapper-dir "./wrapper copy"` passed the installer's reader check in the install's cwd and was
// baked in literally, so a named launch from any other project looked for the reader relative to ITS cwd and
// refused with 78, and the lease helper silently fell back to its no-op stubs. Quoting kept the space, not the
// location. install.sh resolves the directory before rendering; render.sh refuses a relative one, so a host that
// renders without install.sh (aify-comms does) cannot bake one in either.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { definitionsEnv, readerWrapper } from "./definition-reader-wrapper.mjs";
import { RUNTIME_COMMANDS, sealedPath, withPath } from "./sealed-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const RENDER = path.join(ROOT, "render.sh");
const NOWHERE = "http://127.0.0.2:1";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `aify-${name}-`));
const DEFINITION = { version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "claude", mode: "resident",
  workspace: "C:/work", model: "opus", effort: "high", instructions: "", env: {}, herdrSpace: true } };

/** Render claude-aify through install.sh, run from `cwd`, with `wrapperArg` as given. */
function install(cwd, wrapperArg, env = process.env) {
  const out = tmp("wrapdir-out");
  const run = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", posix(out),
    "--bridge-dir", posix(tmp("wrapdir-bridge")), "--registry", posix(path.join(tmp("wrapdir-reg"), "services.json")),
    "--wrapper-dir", wrapperArg], { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { run, launcher: path.join(out, "claude-aify") };
}

/** `claude-aify --check --aify-agent lead`, from `cwd`, with a definition the reader can only find if it runs. */
function checkNamed(launcher, cwd) {
  const home = tmp("wrapdir-home");
  const defs = definitionsEnv(path.join(home, "defs")).AIFY_AGENT_DEFINITIONS_DIR;
  fs.writeFileSync(path.join(defs, "lead.json"), JSON.stringify(DEFINITION));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(AIFY_|HARNESS_|CLAUDE_|CODEX_|HERMES_|HERDR_)/.test(key)) env[key] = value;
  const sealed = sealedPath(RUNTIME_COMMANDS);
  try {
    return spawnSync("bash", [launcher, "--check", "--aify-agent", "lead"], { cwd, encoding: "utf8",
      env: withPath({ ...env, AIFY_COMMS_URL: NOWHERE, AIFY_AGENT_DEFINITIONS_DIR: defs, HOME: home, USERPROFILE: home }, sealed.PATH) });
  } finally {
    fs.rmSync(sealed.dir, { recursive: true, force: true });
  }
}

const role = (stdout) => (/^ {2}role\s*: (.*)$/m.exec(stdout) || [])[1];

test("THE WITNESS: a RELATIVE --wrapper-dir still finds its reader when the launcher runs from another directory", () => {
  const installCwd = tmp("wrapdir-install-cwd");
  readerWrapper(path.join(installCwd, "wrapper copy"));
  const { run, launcher } = install(installCwd, "./wrapper copy");
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const elsewhere = tmp("wrapdir-other-project");
  const named = checkNamed(launcher, elsewhere);
  assert.equal(named.status, 0, `a named launch from another directory refused:\n${named.stdout}${named.stderr}`);
  assert.equal(role(named.stdout), "reviewer", "the definition was not read");
  const baked = /^AIFY_WRAPPER_DIR_FWD="([^"]*)"$/m.exec(fs.readFileSync(launcher, "utf8"))?.[1];
  assert.match(baked ?? "", /^(\/|[A-Za-z]:[\\/])/, `baked wrapper dir is not absolute: ${baked}`);
});

test("POSITIVE CONTROL: an ABSOLUTE --wrapper-dir with a space in it renders and reads, from another directory", () => {
  const wrapper = readerWrapper(path.join(tmp("wrapdir-abs"), "wrapper copy"));
  const { run, launcher } = install(tmp("wrapdir-install-cwd"), posix(wrapper));
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const named = checkNamed(launcher, tmp("wrapdir-other-project"));
  assert.equal(named.status, 0, `${named.stdout}${named.stderr}`);
  assert.equal(role(named.stdout), "reviewer");
});

/** A directory as bash names it: CDPATH is colon-separated, so a Windows `C:/...` would split in two. */
const shellDir = (dir) => spawnSync("bash", ["-c", 'cd -- "$1" && pwd', "_", posix(dir)], { encoding: "utf8" }).stdout.trim();

test("A BARE RELATIVE --wrapper-dir means the install's cwd, even with an exported CDPATH holding a decoy", () => {
  // Review of 0.9.7 (C2): `cd` searches an exported CDPATH for a bare relative name and PRINTS the directory it
  // chose, so the captured root was "path\npath", or a different directory of the same name entirely.
  const installCwd = tmp("wrapdir-install-cwd");
  readerWrapper(path.join(installCwd, "wrapper copy"));
  const decoyParent = tmp("wrapdir-cdpath-decoy");
  fs.mkdirSync(path.join(decoyParent, "wrapper copy")); // no reader in it: a launcher pointed here refuses 78
  const env = { ...process.env, CDPATH: shellDir(decoyParent) };

  // CONTROL: the decoy is live. Plain bash, in the install's cwd, with this CDPATH, goes to the decoy and says so.
  const plain = spawnSync("bash", ["-c", 'cd "wrapper copy" && pwd'], { cwd: installCwd, env, encoding: "utf8" });
  const lines = plain.stdout.trim().split("\n");
  assert.equal(lines.length, 2, `bash did not print the CDPATH match, so this fixture tests nothing: ${JSON.stringify(plain.stdout)}`);
  assert.match(lines[1], /wrapdir-cdpath-decoy/, "bash did not choose the decoy, so this fixture tests nothing");

  const { run, launcher } = install(installCwd, "wrapper copy", env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const text = fs.readFileSync(launcher, "utf8");
  const baked = /^AIFY_WRAPPER_DIR_FWD="([^"]*)"$/m.exec(text)?.[1];
  assert.ok(baked, "no wrapper root baked");
  assert.doesNotMatch(baked, /\n/, `the wrapper root was baked across lines: ${JSON.stringify(baked)}`);
  assert.match(baked, /wrapdir-install-cwd-[^/]*\/wrapper copy$/, `resolved to the wrong directory: ${baked}`);
  const named = checkNamed(launcher, tmp("wrapdir-other-project"));
  assert.equal(named.status, 0, `${named.stdout}${named.stderr}`);
  assert.equal(role(named.stdout), "reviewer");
});

test("a --wrapper-dir that does not exist is refused before any launcher is written", () => {
  const { run, launcher } = install(tmp("wrapdir-install-cwd"), "./no-such-wrapper");
  assert.equal(run.status, 78, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /--wrapper-dir/);
  assert.equal(fs.existsSync(launcher), false);
});

test("render.sh refuses a relative or empty WRAPPER_DIR, and takes an absolute one", () => {
  const pairs = ["ENDPOINT=x", "REGISTRY_FINGERPRINT=fp", "SERVICE_NAME=aify-comms", "WRAPPER_VERSION=0", "NATIVE_BASE=/b",
    "SCRIPT_DIR=/b", "MCP_TRANSPORT=stdio", "BRIDGE_DIR=/b/mcp/stdio", "STRICT_EXTRA_MCP_B64=", "SESSION_MCP_B64="];
  const render = (wrapperDir) => {
    const out = path.join(tmp("wrapdir-render"), "claude-aify");
    const r = spawnSync("bash", [RENDER, "claude-aify.sh.in", posix(out), ...pairs, `WRAPPER_DIR=${wrapperDir}`], { encoding: "utf8", timeout: 120_000 });
    return { ...r, written: fs.existsSync(out) };
  };
  for (const relative of ["./wrapper copy", "wrapper", ""]) {
    const r = render(relative);
    assert.equal(r.status, 78, `'${relative}' was accepted: ${r.stderr}`);
    assert.match(r.stderr, /WRAPPER_DIR must be an absolute path/);
    assert.equal(r.written, false);
  }
  for (const absolute of ["/opt/aify wrapper", "C:/Users/x/aify wrapper"]) {
    const r = render(absolute);
    assert.equal(r.status, 0, `'${absolute}' was refused: ${r.stderr}`);
  }
});
