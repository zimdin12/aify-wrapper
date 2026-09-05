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
  for (const name of ["claude", "hermes", "pi", "opencode"]) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash${LF}exit 0${LF}`);
  }

  // CODEX GETS A STUB THAT ACTUALLY LISTENS, which is what makes it measurable at all.
  //
  // `codex-aify` starts `codex app-server --listen ws://127.0.0.1:<port>` and then `wait_for_port`s
  // it, exiting 1 when nothing answers. An `exit 0` stub therefore failed the BARE case, so codex
  // fell out of `drivable()` and every assertion in this file silently skipped it -- which is how
  // R9-H4 (`--shared --resume` running locally) lived in a launcher this file was watching. An
  // external reviewer found it by hand and noted this harness "cannot see codex".
  //
  // The stub does the minimum that makes the wrapper proceed: on `app-server`, open a TCP socket on
  // the port named by `--listen` and hold it until killed. Every other invocation exits 0 like the
  // rest. It speaks no protocol, because nothing here asks it to.
  // The listener lives in its OWN file rather than inside `node -e`. A one-liner would need quotes
  // nested three deep (JS inside bash inside JS) and the first attempt produced an octal escape that
  // failed to parse. A separate file has no nesting to get wrong.
  fs.writeFileSync(path.join(bin, "app-server-stub.mjs"), [
    'import net from "node:net";',
    'const port = Number(String(process.argv[2] || "").split(":").pop());',
    'net.createServer().listen(port, "127.0.0.1");',
    "setInterval(() => {}, 1e9);",
    "",
  ].join(LF));
  fs.writeFileSync(path.join(bin, "codex"), [
    "#!/usr/bin/env bash",
    "IS_SERVER=",
    "LISTEN=",
    "PREV=",
    'for a in "$@"; do',
    '  [ "$a" = "app-server" ] && IS_SERVER=1',
    '  [ "$PREV" = "--listen" ] && LISTEN="$a"',
    '  PREV="$a"',
    "done",
    'if [ -n "$IS_SERVER" ] && [ -n "$LISTEN" ]; then',
    '  exec node "$(dirname "$0")/app-server-stub.mjs" "$LISTEN"',
    "fi",
    // EVERY OTHER INVOCATION IS RECORDED. Without this the negative control below could only say
    // "aify-env was not called", which is equally true of a wrapper that resumed correctly and one
    // that dropped the resume and started a fresh session -- and a mutation that skipped the resume
    // block entirely passed it. Recording the args is what lets the control tell those apart.
    '[ -n "${AIFY_CODEX_MARKER:-}" ] && printf \'%s\\n\' "$*" >> "$AIFY_CODEX_MARKER"',
    "exit 0",
    "",
  ].join(LF));
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

// ── R9-H4: `--shared --resume` must not resume in THIS terminal ──────────────────────────────
//
// External review, 2026-09-06. R8-H6's shape, in the launcher beside the one that was fixed.
// `codex-aify` looks for the saved session and, when it finds one, runs `codex ... resume` here and
// `exit $?`s -- eighteen lines above the `--shared` block, which therefore never executes. aify-env
// was never called and nothing was printed, so the operator gets a working codex that is simply not
// shared and no indication the flag was ignored. hermes learned this at its own agent-id branch.
//
// THE SESSION HAS TO EXIST for the bug to fire: with no saved session the lookup misses, the wrapper
// falls through to "starting fresh codex" and reaches the shared block anyway. A test that forgot to
// seed one would pass against the broken wrapper.

/** Seed a saved codex session inside the sealed HOME so the resume lookup finds it. */
function seedCodexSession(handle) {
  const { dir } = world();
  const sessions = path.join(dir, ".codex", "sessions", handle);
  fs.mkdirSync(sessions, { recursive: true });
  return handle;
}

test("CODEX --shared --resume HANDS THE SESSION TO THE HOST, not to this terminal", () => {
  const can = drivable();
  // Scoped like every other assertion here, but LOUD about it: codex was unmeasured in this file
  // until its stub learned to listen, and that silence is how R9-H4 lived in a launcher this file
  // was supposedly watching.
  assert.ok(
    can.includes("codex-aify"),
    "codex-aify is not drivable here, so this file cannot see the defect R9-H4 names. That was the "
    + "state it shipped in; the app-server stub exists to end it.",
  );

  const handle = seedCodexSession("sess-r9h4-shared");
  const { asked, call } = askedTheHost("codex-aify", ["--resume", handle]);
  assert.ok(
    asked,
    "codex-aify --shared --resume <id> resumed LOCALLY and exited before the --shared block. "
    + "aify-env was never asked to take the session.",
  );
  assert.match(call, new RegExp(handle), "the handle must travel to the host, or it resumes nothing");
});

test("NEGATIVE CONTROL: without --shared, a resume still runs locally", () => {
  // The guard must be about `--shared` and nothing else. If this also reached the host, the fix
  // would have broken the ordinary resume rather than fixed the shared one.
  const { dir, bin, marker } = world();
  const handle = seedCodexSession("sess-r9h4-local");
  const codexMarker = path.join(dir, "codex-calls.txt");
  for (const f of [marker, codexMarker]) if (fs.existsSync(f)) fs.rmSync(f);
  const script = `
    BIN=$(cd ${JSON.stringify(posix(bin))} && pwd)
    DIR=$(cd ${JSON.stringify(posix(dir))} && pwd)
    NODE=$(dirname "$(command -v node)")
    chmod +x "$BIN"/* "$DIR"/*-aify 2>/dev/null
    env -i PATH="$BIN:$NODE:/usr/bin:/bin" HOME="$DIR" TERM=dumb \
      AIFY_TEST_MARKER="$DIR/asked.txt" \
      AIFY_CODEX_MARKER="$DIR/codex-calls.txt" \
      AIFY_COMMS_URL=http://127.0.0.2:1 \
      bash "$DIR/codex-aify" '--resume' '${handle}' >/dev/null 2>&1
    exit 0
  `;
  spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 120_000 });

  assert.ok(
    !fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim().length === 0,
    "an ordinary --resume was handed to the host; the guard is keying on something other than --shared",
  );
  // AND IT ACTUALLY RESUMED. "aify-env was not called" is equally true of a wrapper that dropped the
  // resume and started fresh, so the guard has to be shown NOT to have swallowed the local path.
  const calls = fs.existsSync(codexMarker) ? fs.readFileSync(codexMarker, "utf8") : "";
  assert.match(
    calls,
    new RegExp(`resume[^${LF}]*${handle}`),
    `the local resume never ran: codex was invoked as ${JSON.stringify(calls)}. The guard widened `
    + "past --shared and now swallows an ordinary resume.",
  );
});
