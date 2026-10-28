// bin/aify-herdr-launch.sh and bin/aify-node-22.sh, sourced by the launchers, driven in bash as the launchers drive them.
//
// The claim's success path runs through rendered launchers in the a-claimed-pane-* tests. What only these hold: the
// host's XDG profile given back inside an isolated Herdr (nothing else tests it), that neither helper can fail a launch
// under `set -euo pipefail`, and which node hermes is given.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = (p) => p.split(path.sep).join("/");
//: A path as bash on this host lists it in PATH: Git Bash reads `C:/x` there as two entries, `C` and `/x`.
const shellPath = (p) => (process.platform === "win32" ? posix(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) : posix(p));
const HERDR = posix(path.join(ROOT, "bin", "aify-herdr-launch.sh"));
const NODE22 = posix(path.join(ROOT, "bin", "aify-node-22.sh"));

/** Run `script` in bash under the launchers' own strictness, with `env` over a minimal environment. */
function bash(script, env = {}) {
  const base = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? "", HOME: fs.mkdtempSync(path.join(os.tmpdir(), "aify-helpers-")) };
  return spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${script}`], { env: { ...base, ...env }, encoding: "utf8" });
}

const SHOW = 'printf "config=%s state=%s\\n" "${XDG_CONFIG_HOME-<unset>}" "${XDG_STATE_HOME-<unset>}"';

test("inside an isolated Herdr the host's XDG roots come back: set, set but empty, and never set", () => {
  const run = bash(`. "${HERDR}"; aify_herdr_restore_profile; ${SHOW}`, {
    AIFY_HERDR_ISOLATED: "1", XDG_CONFIG_HOME: "/invocation/cfg", XDG_STATE_HOME: "/invocation/state",
    AIFY_HERDR_HOST_XDG_CONFIG_HOME: "/host/cfg",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "config=/host/cfg state=<unset>", "the host had no state root, so the agent gets none");
  const empty = bash(`. "${HERDR}"; aify_herdr_restore_profile; ${SHOW}`, {
    AIFY_HERDR_ISOLATED: "1", XDG_CONFIG_HOME: "/invocation/cfg", AIFY_HERDR_HOST_XDG_CONFIG_HOME: "",
  });
  assert.equal(empty.stdout.trim(), "config= state=<unset>", "set-but-empty is kept empty, not unset");
  const ordinary = bash(`. "${HERDR}"; aify_herdr_restore_profile; ${SHOW}`, { XDG_CONFIG_HOME: "/mine", AIFY_HERDR_HOST_XDG_CONFIG_HOME: "/host/cfg" });
  assert.equal(ordinary.stdout.trim(), "config=/mine state=<unset>", "an ordinary launch is left alone");
});

test("a claim that fails costs the pane its label, never the launch; a pane file without a pane claims nothing", () => {
  // A helper that cannot run stands in for a Herdr that is busy or gone.
  const failing = bash(`AIFY_HERDR_ARGV=(x); . "${HERDR}"; aify_herdr_claim_pane; printf "claim=[%s] pane=[%s]\\n" "\${AIFY_HERDR_CLAIM-}" "\${HERDR_PANE_ID-}"`,
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", AIFY_WRAPPER_DIR_FWD: "/nowhere" });
  assert.equal(failing.status, 0, failing.stderr);
  assert.equal(failing.stdout.trim(), "claim=[] pane=[w1:p1]", "an unclaimed pane keeps Herdr's own variable");
  assert.equal(failing.stderr, "", "the failure printed into the operator's terminal");
  for (const [flag, helper] of [["--pane-file", "/w/bin/aify-herdr-pane.mjs"], ["", "<unset>"]]) {
    const run = bash(`. "${HERDR}"; aify_herdr_claim_pane ${flag}; printf "%s|%s\\n" "\${AIFY_HERDR_HELPER-<unset>}" "\${AIFY_HERDR_CLAIM-<unset>}"`,
      { AIFY_HERDR_PANE_FILE: "/state/pane", AIFY_WRAPPER_DIR_FWD: "/w" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), `${helper}|<unset>`, `flag ${flag || "(none)"}`);
  }
});

/** A directory holding a `node` that reports `version`. */
function fakeNode(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node"), `#!/bin/bash\necho ${version}\n`, { mode: 0o755 });
  return shellPath(dir);
}

test("hermes gets a Node >= 22: the one on PATH, else HERMES_NODE, else nvm's newest, else a warning and the launch goes on", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-node22-"));
  const old = fakeNode(path.join(root, "system"), "v20.11.0");
  const nvm = path.join(root, "nvm");
  for (const v of ["v20.1.0", "v22.3.0", "v24.0.1"]) fakeNode(path.join(nvm, "versions", "node", v, "bin"), v);
  const pinned = fakeNode(path.join(root, "pinned"), "v22.9.0");
  const pick = (env) => bash(`. "${NODE22}"; aify_ensure_node_ge_22; printf "%s|%s\\n" "\${PATH%%:*}" "\${HERMES_NODE-<unset>}"`,
    { PATH: `${old}:${process.env.PATH}`, NVM_DIR: shellPath(nvm), ...env });

  const scanned = pick({});
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(scanned.stdout.trim(), `${shellPath(path.join(nvm, "versions", "node", "v24.0.1", "bin"))}|${shellPath(path.join(nvm, "versions", "node", "v24.0.1", "bin", "node"))}`);
  assert.equal(pick({ HERMES_NODE: `${pinned}/node` }).stdout.trim(), `${pinned}|${pinned}/node`, "an explicit HERMES_NODE >= 22 wins");
  const current = fakeNode(path.join(root, "current"), "v23.0.0");
  const fine = bash(`. "${NODE22}"; aify_ensure_node_ge_22; printf "%s\\n" "\${PATH%%:*}"`, { PATH: `${current}:${process.env.PATH}`, NVM_DIR: shellPath(nvm) });
  assert.equal(fine.stdout.trim(), current, "a node >= 22 already on PATH is left first");
  const none = pick({ NVM_DIR: shellPath(path.join(root, "no-nvm")) });
  assert.equal(none.status, 0, "no suitable node still starts");
  assert.match(none.stderr, /Node >=22 not found \(current node: 20\)/);
  assert.equal(pick({ AIFY_HERMES_SKIP_NODE_CHECK: "1" }).stdout.trim(), `${old}|<unset>`, "the opt-out changes nothing");
});

// THE LAUNCHERS CALL IT: a rendered launcher run to a stub runtime, inside an isolated Herdr, hands the runtime the
// host's roots. The claim's own launcher tests need a spawnable stub herdr, which Windows lacks; this one runs anywhere.
for (const client of ["claude", "codex", "hermes", "pi"]) {
  test(`${client}: inside an isolated Herdr its runtime starts with the host's XDG roots, not the invocation's`, () => {
    const result = launch(client, [], { env: {
      AIFY_HERDR_ISOLATED: "1", AIFY_HERDR_HOST_XDG_CONFIG_HOME: "/host/cfg", XDG_CONFIG_HOME: "/invocation/cfg", XDG_STATE_HOME: "/invocation/state",
      // pi runs `omp` unless told otherwise; the stub runtime is named for its client.
      ...(client === "pi" ? { AIFY_PI_COMMAND: "pi" } : {}),
    } });
    assert.equal(result.run.status, 0, `${result.run.stdout}\n${result.run.stderr}`);
    assert.equal(result.started.XDG_CONFIG_HOME, "/host/cfg");
    assert.equal(result.started.XDG_STATE_HOME, undefined, "the host had no state root");
  });
}
