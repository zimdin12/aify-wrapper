// The wrapper's installer refuses to write launchers that point at a bridge with no definition reader
// (external review of 0.8.1: the upgrade-order trap).
//
// Each launcher reads a named agent's definition with the reader in the bridge it points at, and refuses
// (78) when it cannot run it. Installed ahead of the service's own install, every named start refused until
// that install ran. The control is the same install against a bridge that has the reader.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `aify-${name}-`));

function install(bridge, client = "claude") {
  const dest = tmp("reader-dest");
  const run = spawnSync("bash", [INSTALL, "--client", client, "--endpoint", "http://127.0.0.1:1", "--dest", posix(dest),
    "--bridge-dir", posix(bridge), "--registry", posix(path.join(tmp("reader-reg"), "services.json"))],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env, AIFY_NO_PROMPT: "1" } });
  return { run, written: fs.readdirSync(dest) };
}

test("a bridge with no reader: refused, naming the install to run first, and nothing written", () => {
  const { run, written } = install(tmp("bridge-without-reader"));
  assert.equal(run.status, 78, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /has no definition reader/);
  assert.match(run.stderr, /aify-comms: install\.sh --client <name>/);
  assert.deepEqual(written, [], "no launcher that would refuse every named start");
});

test("CONTROL: the same install against a bridge with the reader writes the launcher", () => {
  const bridge = tmp("bridge-with-reader");
  fs.mkdirSync(path.join(bridge, "node_modules", "aify-wrapper", "bin"), { recursive: true });
  fs.writeFileSync(path.join(bridge, "node_modules", "aify-wrapper", "bin", "aify-definition.mjs"), "");
  const { run, written } = install(bridge);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(written.includes("claude-aify"), `written: ${written}`);
});

test("a launcher that reads no definition is written without the reader (pi; review of 0.8.2)", () => {
  // Which launchers are held is read from their templates; pi's has no reader call, so holding it held nothing.
  const { run, written } = install(tmp("bridge-without-reader"), "pi");
  assert.equal(run.status, 0, `${run.stdout}
${run.stderr}`);
  assert.ok(written.includes("pi-aify"), `written: ${written}`);
});
