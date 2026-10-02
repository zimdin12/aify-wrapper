// What only codex refuses stops only an install that writes a codex launcher. (A dotted name also stops hermes, whose
// config nests on dots; the last case says so.)
//
// The codex verb refuses things that are codex's limits, not the registry's: a server name that is not a bare
// TOML key (`a.b` would be read by codex as a nested table) and a key kept in a variable codex forwards. The
// parse refusals every client shares stay where they were. Found in review of fcb02f3, which built the codex
// words for every install: an opted-in server named `a.b` then stopped claude, hermes and pi installs too,
// though none of them can be affected by what codex parses.
//
// Each case renders through install.sh --render-only against its own registry, on a sealed PATH for --all.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sealedPath, withPath } from "./sealed-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

const registryNaming = (serverName) => ({
  version: 1,
  services: {
    "aify-dashboard": {
      endpoint: "http://127.0.0.2:9700",
      credentialRef: "aify-dashboard.key",
      sessionInject: { mcp: true },
      mcp: [{ name: serverName, command: "node", args: ["/d/bridge.mjs"] }],
    },
  },
});

function install(selection, serverName, { runtimes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-codex-only-"));
  const out = path.join(dir, "out");
  const registry = path.join(dir, "services.json");
  fs.writeFileSync(registry, JSON.stringify(registryNaming(serverName)));
  const env = runtimes === undefined ? process.env : withPath(process.env, sealedPath(runtimes).PATH);
  const run = spawnSync("bash", [INSTALL, ...selection, "--endpoint", "http://127.0.0.2:1", "--registry", posix(registry),
    "--render-only", posix(out)], { encoding: "utf8", timeout: 180_000, env });
  const written = fs.existsSync(out) ? fs.readdirSync(out).filter((name) => !name.includes(".render.")).sort() : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, written };
}

for (const client of ["claude", "pi"]) {
  test(`a server name codex cannot take does not stop a ${client} install`, () => {
    const { run, written } = install(["--client", client], "a.b");
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.ok(written.includes(`${client}-aify`), `wrote ${written.join(", ")}`);
  });
}

test("the same name stops a codex install, and writes nothing", () => {
  const { run, written } = install(["--client", "codex"], "a.b");
  assert.equal(run.status, 78, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /not a plain TOML key/);
  assert.deepEqual(written, []);
});

test("a name codex can take installs codex (the control: the refusal above is about the name)", () => {
  const { run, written } = install(["--client", "codex"], "aify-dashboard");
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(written, ["codex-aify"]);
});

test("--all with codex present refuses before writing ANY launcher", () => {
  // The bug this catches: checking codex's words inside the per-client loop, so claude-aify is written before
  // codex refuses, and the install exits 78 having half-happened.
  const { run, written } = install(["--all"], "a.b", { runtimes: ["claude", "codex"] });
  assert.equal(run.status, 78, `${run.stdout}${run.stderr}`);
  assert.deepEqual(written, []);
});

test("--all without codex installs what is present", () => {
  const { run, written } = install(["--all"], "a.b", { runtimes: ["claude"] });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(written, ["claude-aify"]);
});

test("hermes refuses the same name, because it would be a nested key in hermes' config too", () => {
  // Not a codex-only limit after all: hermes' entries are written as `mcp_servers.<name>`, so a dot nests it. Refused
  // before any launcher is written, like codex's, and with nothing written to the user's hermes config either.
  const { run, written } = install(["--client", "hermes"], "a.b");
  assert.equal(run.status, 78, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /not a plain key/);
  assert.deepEqual(written, []);
});
