#!/usr/bin/env node
// `--shared` must REACH aify-env, not merely be written into the file.
//
// EXTERNAL REVIEW, Round 8 H6. The existing suite asserts every launcher CONTAINS
// `exec aify-env run` and that the block sits below everything. Both were true of hermes while
// `--shared` was unreachable for the case it exists for: the agent-id branch -- an agent id with no
// other arguments, which IS the ordinary managed launch -- runs kill-prior, ensure-host and the TUI
// and EXITS, two hundred lines above the block. A file can contain a line it never executes, and
// every source-reading assertion in this repo is blind to that by construction.
//
// SO THIS RUNS THEM, against stubs, and asks the only question that matters: did the host get asked
// to take the session? Nothing here reads a launcher's text.
//
// EACH LAUNCHER IS ITS OWN CONTROL, and that is what makes the answer honest. A launcher may fail to
// reach the stub for reasons that are nothing to do with `--shared`: codex starts an app-server
// first and exits when it cannot reach one, which no stub here provides. So the BARE case calibrates
// the harness per launcher, and only a launcher the harness can demonstrably drive is judged on the
// agent-id case. A launcher that fails both is REPORTED AS UNMEASURED rather than as broken --
// without that split this file would have accused codex of H6 on the strength of a missing stub.
//
// SEALED: `env -i` and a PATH holding only the stubs, node (which the wrappers legitimately use) and
// the system directories. No agent id, no credential, no session handle from this process, and an
// endpoint that answers nowhere. An unsealed run picked up this session's own CLAUDE_SESSION_ID and
// agent id on the first attempt.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const LF = String.fromCharCode(10);
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

/** Every launcher this repo renders. DERIVED, so a fifth wrapper is covered the day it lands. */
const LAUNCHERS = fs.readdirSync(path.join(ROOT, "wrappers"))
  .filter((name) => name.endsWith("-aify.sh.in"))
  .map((name) => name.replace(".sh.in", ""))
  .sort();

let WORLD = null;

/** Render every launcher once, beside a stub `aify-env` and a stub for each runtime. */
function world() {
  if (WORLD) return WORLD;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-shared-run-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });

  const result = spawnSync("bash", [
    INSTALL, "--all", "--endpoint", "http://127.0.0.2:1", "--render-only", posix(dir),
  ], { encoding: "utf8", timeout: 180_000 });
  assert.equal(result.status, 0, result.stderr);

  const rendered = LAUNCHERS.filter((name) => fs.existsSync(path.join(dir, name)));
  assert.ok(rendered.length >= 3, `only ${rendered.length} launcher(s) rendered; nothing to test`);

  // The stub the whole file turns on: it records the call and exits, the way `exec` replaces the
  // launcher in the real thing. Written from inside bash so the path is POSIX -- a Windows-shaped
  // PATH entry is invisible to `command -v`, which cost the first version of this test an hour of
  // "all four are broken" that was really one wrong path separator.
  fs.writeFileSync(path.join(bin, "aify-env-stub.sh"),
    `#!/usr/bin/env bash${LF}printf '%s\\n' "$*" >> "$AIFY_TEST_MARKER"${LF}exit 0${LF}`);
  for (const name of ["claude", "codex", "hermes", "pi", "opencode"]) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash${LF}exit 0${LF}`);
  }
  fs.copyFileSync(path.join(bin, "aify-env-stub.sh"), path.join(bin, "aify-env"));

  WORLD = { dir, bin, rendered, marker: path.join(dir, "asked.txt") };
  return WORLD;
}

/**
 * Run one launcher with `--shared` and report whether aify-env was asked to host the session.
 *
 * Driven through `bash -c` so the PATH is built with `cd && pwd` INSIDE bash: node's `os.tmpdir()`
 * hands back a Windows path, and bash's own lookup cannot use one.
 */
function askedTheHost(name, extraArgs = []) {
  const { dir, bin, marker } = world();
  if (fs.existsSync(marker)) fs.rmSync(marker);
  const args = [...extraArgs, "--shared"].map((a) => `'${a}'`).join(" ");
  const script = `
    BIN=$(cd ${JSON.stringify(posix(bin))} && pwd)
    DIR=$(cd ${JSON.stringify(posix(dir))} && pwd)
    NODE=$(dirname "$(command -v node)")
    chmod +x "$BIN"/* "$DIR"/*-aify 2>/dev/null
    env -i PATH="$BIN:$NODE:/usr/bin:/bin" HOME="$DIR" TERM=dumb \
      AIFY_TEST_MARKER="$DIR/asked.txt" \
      AIFY_COMMS_URL=http://127.0.0.2:1 \
      bash "$DIR/${name}" ${args} >/dev/null 2>&1
    exit 0
  `;
  spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 120_000 });
  return {
    asked: fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim().length > 0,
    call: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "",
  };
}

/** Launchers the harness can demonstrably drive: `--shared` alone reaches the stub. */
function drivable() {
  return world().rendered.filter((name) => askedTheHost(name).asked);
}

test("the harness can drive at least one launcher to the host", () => {
  // POSITIVE CONTROL. Every assertion below reads "the marker exists", and a broken harness produces
  // a missing marker for every launcher -- which reads as "they are all broken" and sends the next
  // person to fix code that is fine. That is not hypothetical: it happened while writing this.
  const can = drivable();
  assert.ok(can.length > 0,
    "no launcher reached the aify-env stub even with a bare --shared, so this file cannot tell a "
    + "working launcher from a broken harness and proves nothing");
});

test("EVERY DRIVABLE LAUNCHER ALSO HANDS AN AGENT-ID SESSION TO THE HOST", () => {
  // THE CASE THE FEATURE EXISTS FOR, and the one hermes swallowed. Scoped to launchers the bare case
  // proved the harness can drive, so a missing prerequisite cannot masquerade as this defect.
  const can = drivable();
  const silent = can.filter((name) => !askedTheHost(name, ["--aify-agent", "sc-shared-probe"]).asked);
  assert.deepEqual(silent, [],
    `${silent.join(", ")} ran an --aify-agent session LOCALLY despite --shared. The flag is consumed `
    + "at the top of every template, so the operator gets a session that dies with the terminal "
    + "while believing the host owns it, and nothing is printed either way.");
});

test("the launcher it names is ITSELF, so the host re-runs the right program", () => {
  // A `--shared` that reaches the host and names the wrong launcher is worse than one that does
  // nothing: the host starts something else on the operator's behalf.
  for (const name of drivable()) {
    const { call } = askedTheHost(name, ["--aify-agent", "sc-shared-probe"]);
    assert.match(call, new RegExp(`--launcher [^ ]*${name}`),
      `${name} asked the host to run something other than itself: ${call}`);
  }
});

test("what the harness could NOT drive is named, never silently passed over", () => {
  // A scoped population is only honest if its exclusions are visible. A launcher that fails the bare
  // case is unmeasured here -- codex starts an app-server no stub provides -- and saying so is the
  // difference between "these three are proven" and "all of them are fine".
  const { rendered } = world();
  const can = drivable();
  const unmeasured = rendered.filter((name) => !can.includes(name));
  assert.ok(can.length >= 2,
    `only ${can.length} of ${rendered.length} launcher(s) could be driven here `
    + `(unmeasured: ${unmeasured.join(", ") || "none"}). Below two, this file is not evidence about `
    + "the fleet -- it is evidence about one launcher.");
});
