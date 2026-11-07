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

function install({ wrapper, client = "claude", env = {}, dest = tmp("reader-dest") } = {}) {
  const run = spawnSync("bash", [INSTALL, "--client", client, "--endpoint", "http://127.0.0.1:1", "--dest", posix(dest),
    "--bridge-dir", posix(tmp("bridge-without-the-wrapper")), ...(wrapper ? ["--wrapper-dir", posix(wrapper)] : []),
    "--registry", posix(path.join(tmp("reader-reg"), "services.json"))],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env, AIFY_NO_PROMPT: "1", ...env } });
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
  for (const file of ["aify-input-boundary.sh", "aify-launcher-common.sh", ...files]) fs.writeFileSync(path.join(wrapper, "bin", file), "");
  return wrapper;
}

/** The helpers a launcher skips without a word, which install.sh requires beside the reader. */
const SILENT_HELPERS = ["aify-herdr-launch.sh", "aify-node-22.sh"];

test("a --wrapper-dir with no reader, or half of one: refused, naming the option, and nothing written", () => {
  for (const wrapper of [wrapperWith("wrapper-without-reader", SILENT_HELPERS), wrapperWith("wrapper-without-shell-side", ["aify-definition.mjs", ...SILENT_HELPERS]),
    wrapperWith("wrapper-without-node-side", ["aify-definition.sh", ...SILENT_HELPERS])]) {
    const { run, written } = install({ wrapper });
    assert.equal(run.status, 78, `${wrapper}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /has no definition reader \(bin\/aify-definition\.mjs and bin\/aify-definition\.sh\)/);
    assert.match(run.stderr, /--wrapper-dir/);
    assert.deepEqual(written, [], "no launcher that would refuse every named start");
  }
});

test("CONTROL: the same install against a --wrapper-dir with the reader writes the launcher", () => {
  const wrapper = wrapperWith("wrapper-with-reader", ["aify-definition.mjs", "aify-definition.sh", ...SILENT_HELPERS]);
  const { run, written } = install({ wrapper });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(written.includes("claude-aify"), `written: ${written}`);
});

test("a --wrapper-dir without a helper the launcher would skip without a word: refused, naming it, nothing written", () => {
  // Herdr's claim and profile for every launcher; Node >= 22 for hermes only, so a claude install does not need it.
  const reader = ["aify-definition.mjs", "aify-definition.sh"];
  // And hermes' pending config step, without which a change an install recorded is never applied.
  for (const [client, files, missing] of [["claude", reader, "aify-herdr-launch.sh"], ["pi", [], "aify-herdr-launch.sh"],
    ["hermes", [...reader, "aify-herdr-launch.sh"], "aify-node-22.sh"],
    ["hermes", [...reader, "aify-herdr-launch.sh", "aify-node-22.sh"], "aify-hermes-pending-config.mjs"]]) {
    const { run, written } = install({ wrapper: wrapperWith(`wrapper-without-${missing}`, files), client });
    assert.equal(run.status, 78, `${client}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, new RegExp(`has no bin/${missing.replaceAll(".", "\\.")}, which the ${client} launcher sources`));
    assert.deepEqual(written, [], `${client}: written anyway`);
  }
  const { run } = install({ wrapper: wrapperWith("wrapper-for-claude", [...reader, "aify-herdr-launch.sh"]), client: "claude" });
  assert.equal(run.status, 0, `CONTROL: claude needs no Node 22 helper: ${run.stderr}`);
});

// New property: every independently installable template must have its mandatory runtime validator.
// Earlier missing-helper cases guard optional/skipped helpers, not this fail-closed dependency.
for (const client of ["claude", "codex", "hermes", "pi"]) test(`${client}: missing input boundary refuses before installing a launcher`, () => {
  const files = ["aify-definition.mjs", "aify-definition.sh", ...SILENT_HELPERS, "aify-hermes-pending-config.mjs"];
  const wrapper = wrapperWith("wrapper-without-boundary", files);
  fs.unlinkSync(path.join(wrapper, "bin", "aify-input-boundary.sh"));
  // A deleted installer guard must hit an owned tripwire, not run later config/process inspection.
  const stubs = tmp("boundary-node-tripwire"), marker = path.join(stubs, "called");
  fs.writeFileSync(path.join(stubs, "node"), '#!/bin/bash\nprintf called > "$BOUNDARY_NODE_MARKER"\nexit 91\n', { mode: 0o755 });
  const { run, written } = install({ wrapper, client, env: { PATH: stubs + path.delimiter + process.env.PATH, BOUNDARY_NODE_MARKER: posix(marker) } });
  assert.equal(run.status, 78, run.stderr);
  assert.match(run.stderr, /has no bin\/aify-input-boundary\.sh/);
  assert.equal(fs.existsSync(marker), false, "missing validator must refuse before a Node child");
  assert.deepEqual(written, [], "missing validator must not install an unusable launcher");
});

// New common-function prerequisite: all four installable clients refuse before Node or target replacement.
for (const client of ["claude", "codex", "hermes", "pi"]) test(`${client}: missing launcher common helper preserves the target before any Node child`, () => {
  const wrapper = wrapperWith("wrapper-without-common", ["aify-definition.mjs", "aify-definition.sh", ...SILENT_HELPERS, "aify-hermes-pending-config.mjs"]);
  fs.unlinkSync(path.join(wrapper, "bin", "aify-launcher-common.sh"));
  const dest = tmp("common-existing-target"), target = path.join(dest, `${client}-aify`), before = Buffer.from("owned prior launcher bytes");
  fs.writeFileSync(target, before);
  const stubs = tmp("common-node-tripwire"), marker = path.join(stubs, "unexpected"), positive = path.join(stubs, "positive");
  fs.writeFileSync(path.join(stubs, "node"), '#!/bin/bash\nprintf called > "$COMMON_NODE_MARKER"\nexit 91\n', { mode: 0o755 });
  const PATH = stubs + path.delimiter + process.env.PATH;
  const control = spawnSync("bash", ["-c", "node"], { env: { ...process.env, PATH, COMMON_NODE_MARKER: posix(positive) }, encoding: "utf8" });
  assert.equal(control.status, 91, control.stderr);assert.equal(fs.readFileSync(positive, "utf8"), "called");
  const { run, written } = install({ wrapper, client, dest, env: { PATH, COMMON_NODE_MARKER: posix(marker) } });
  assert.deepEqual({ status: run.status, named: /has no bin\/aify-launcher-common\.sh/.test(run.stderr), nodeCalled: fs.existsSync(marker), target: fs.readFileSync(target), written },
    { status: 78, named: true, nodeCalled: false, target: before, written: [`${client}-aify`] }, 'common prerequisite refuses before Node or target mutation');
});

test("a launcher that reads no definition is written without the reader (pi; review of 0.8.2)", () => {
  // Which launchers are held is read from their templates; pi's has no reader call, so holding it held nothing.
  const { run, written } = install({ wrapper: wrapperWith("wrapper-without-reader", ["aify-herdr-launch.sh"]), client: "pi" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(written.includes("pi-aify"), `written: ${written}`);
});
