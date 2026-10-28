// The wrapper's installer writes launchers that find their definition reader in the wrapper itself, and
// refuses to write them against a wrapper directory that has none.
//
// Each launcher reads a named agent's definition with bin/aify-definition.mjs and refuses (78) when it cannot
// run it. That reader once lived in the service's bridge, so launchers installed ahead of the service's own
// install refused every named start until it ran (external review of 0.8.1: the upgrade-order trap), and this
// installer refused to install unless the bridge held it. The reader now comes from the wrapper directory
// (`--wrapper-dir`, by default this package), so a bridge without it is no reason to refuse.
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

function install({ wrapper, client = "claude" } = {}) {
  const dest = tmp("reader-dest");
  const run = spawnSync("bash", [INSTALL, "--client", client, "--endpoint", "http://127.0.0.1:1", "--dest", posix(dest),
    "--bridge-dir", posix(tmp("bridge-without-the-wrapper")), ...(wrapper ? ["--wrapper-dir", posix(wrapper)] : []),
    "--registry", posix(path.join(tmp("reader-reg"), "services.json"))],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env, AIFY_NO_PROMPT: "1" } });
  return { run, written: fs.readdirSync(dest) };
}

test("a bridge that holds nothing of aify-wrapper: the launcher is written, finding its reader in this package", () => {
  const { run, written } = install();
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(written.includes("claude-aify"), `written: ${written}`);
  const text = fs.readFileSync(path.join(path.dirname(INSTALL), "wrappers", "claude-aify.sh.in"), "utf8");
  assert.match(text, /@@WRAPPER_DIR@@/, "the template no longer names the wrapper directory, so this proves nothing");
});

/** A --wrapper-dir holding the reader's files named. */
function wrapperWith(name, files) {
  const wrapper = tmp(name);
  fs.mkdirSync(path.join(wrapper, "bin"), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(wrapper, "bin", file), "");
  return wrapper;
}

test("a --wrapper-dir with no reader, or half of one: refused, naming the option, and nothing written", () => {
  for (const wrapper of [tmp("wrapper-without-reader"), wrapperWith("wrapper-without-shell-side", ["aify-definition.mjs"]),
    wrapperWith("wrapper-without-node-side", ["aify-definition.sh"])]) {
    const { run, written } = install({ wrapper });
    assert.equal(run.status, 78, `${wrapper}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /has no definition reader \(bin\/aify-definition\.mjs and bin\/aify-definition\.sh\)/);
    assert.match(run.stderr, /--wrapper-dir/);
    assert.deepEqual(written, [], "no launcher that would refuse every named start");
  }
});

test("CONTROL: the same install against a --wrapper-dir with the reader writes the launcher", () => {
  const wrapper = wrapperWith("wrapper-with-reader", ["aify-definition.mjs", "aify-definition.sh"]);
  const { run, written } = install({ wrapper });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(written.includes("claude-aify"), `written: ${written}`);
});

test("a launcher that reads no definition is written without the reader (pi; review of 0.8.2)", () => {
  // Which launchers are held is read from their templates; pi's has no reader call, so holding it held nothing.
  const { run, written } = install({ wrapper: tmp("wrapper-without-reader"), client: "pi" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(written.includes("pi-aify"), `written: ${written}`);
});
