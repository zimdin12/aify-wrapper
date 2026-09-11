#!/usr/bin/env node
// A wrapper has to know which pane it is in, and must claim that pane under a source Herdr does not
// own. Both are pinned here against what a live Herdr 0.9.0 was measured doing.
//
// WHAT THE MEASUREMENT WAS. In an isolated profile on 2026-09-12, three panes were reported to a
// running Herdr and the server was stopped so it would write `session.json`:
//
//   w1:p1  --source herdr:claude --agent claude       -> persisted agent_session
//   w1:p3  --source herdr:claude --agent claude       -> persisted agent_session   (control)
//   w1:p2  --source herdr:aify   --agent claude-aify  -> persisted label, NO agent_session
//
// and on restart p1 and p3 came back carrying their agent while p2 came back an empty shell still
// carrying its label. So the tests below are not about a naming convention: `AIFY_AGENT_SOURCE` is
// the thing that makes a pane ours to fill, and the label is the only handle that survives.
//
// THE CONTROLS REMOVE WHAT THEY WATCH. Every refusal here is driven by deleting or corrupting the
// exact field the guard is supposed to read, so a guard that stopped reading it fails this file.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AIFY_AGENT_SOURCE,
  AIFY_LABEL_PREFIX,
  paneLabel,
  parsePaneLabel,
  readPaneContext,
  renamePaneArgv,
  reportAgentArgv,
} from "../lib/herdr-pane.mjs";

/** The environment a pane's shell really had, copied from the measured dump. */
function paneEnv(overrides = {}) {
  return {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p2",
    HERDR_TAB_ID: "w1:t2",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_BIN_PATH: "C:\\Users\\Administrator\\.herdr\\packages\\standalone\\releases\\0.9.0\\herdr.exe",
    HERDR_SOCKET_PATH: "C:/tmp/herdr.sock",
    ...overrides,
  };
}

test("a wrapper in a pane learns its pane from the environment Herdr really sets", () => {
  const context = readPaneContext(paneEnv());
  assert.equal(context.paneId, "w1:p2");
  assert.equal(context.workspaceId, "w1");
  assert.equal(context.tabId, "w1:t2");
  assert.ok(context.bin.endsWith("herdr.exe"));
});

test("outside a pane there is no context at all", () => {
  // The ordinary case on this machine: a wrapper started from a normal terminal.
  assert.equal(readPaneContext({}), null);
  assert.equal(readPaneContext({ PATH: "/usr/bin" }), null);
});

test("each required field is load-bearing, proven by removing it one at a time", () => {
  // POSITIVE CONTROL FIRST: the unmodified environment must produce a context, or every refusal
  // below would pass for the trivial reason that nothing ever succeeds.
  assert.ok(readPaneContext(paneEnv()));
  for (const field of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_BIN_PATH"]) {
    const env = paneEnv();
    delete env[field];
    assert.equal(readPaneContext(env), null, `${field} was removed and the guard still produced a context`);
  }
});

test("a malformed id is refused rather than passed through", () => {
  // A wrapper that accepted a bad id would label "some" pane and record a restore entry for it.
  assert.equal(readPaneContext(paneEnv({ HERDR_PANE_ID: "p2" })), null);
  assert.equal(readPaneContext(paneEnv({ HERDR_PANE_ID: "w1:t2" })), null);
  assert.equal(readPaneContext(paneEnv({ HERDR_WORKSPACE_ID: "workspace-1" })), null);
  assert.equal(readPaneContext(paneEnv({ HERDR_TAB_ID: "nonsense" })), null);
  // HERDR_ENV is inherited by children a wrapper spawns; the ids are what say "this pane".
  assert.equal(readPaneContext({ HERDR_ENV: "1" }), null);
});

test("a label round-trips, and only labels we own parse", () => {
  const label = paneLabel({ wrapper: "claude-aify", record: "a1b2c3" });
  assert.equal(label, `${AIFY_LABEL_PREFIX}:claude-aify:a1b2c3`);
  assert.deepEqual({ ...parsePaneLabel(label) }, { wrapper: "claude-aify", record: "a1b2c3" });
  // Someone else's pane name must not be read as ours.
  assert.equal(parsePaneLabel("build"), null);
  assert.equal(parsePaneLabel("other:claude-aify:a1b2c3"), null);
  assert.equal(parsePaneLabel("aify:claude-aify"), null);
  assert.equal(parsePaneLabel(null), null);
  assert.equal(parsePaneLabel(undefined), null);
  // The literal label a hand-driven `--label` produced against the live Herdr, which must not parse.
  assert.equal(parsePaneLabel("--label aify:claude-aify:demo"), null);
});

test("a colon in a field is refused, because the label is colon-delimited", () => {
  // Allowing it would mint a label that parses back to something different from what went in.
  assert.throws(() => paneLabel({ wrapper: "claude:aify", record: "a1" }), /wrapper/);
  assert.throws(() => paneLabel({ wrapper: "claude-aify", record: "a:1" }), /record/);
  assert.throws(() => paneLabel({ wrapper: "", record: "a1" }), /wrapper/);
});

test("the claim reports under the aify source, which is what denies the pane a resume plan", () => {
  const argv = reportAgentArgv({ paneId: "w1:p2", wrapper: "claude-aify" });
  assert.deepEqual(argv, [
    "pane",
    "report-agent",
    "w1:p2",
    "--source",
    AIFY_AGENT_SOURCE,
    "--agent",
    "claude-aify",
    "--state",
    "idle",
  ]);
  // The measured asymmetry depends entirely on this value not being one of Herdr's own.
  assert.equal(AIFY_AGENT_SOURCE, "herdr:aify");
  assert.notEqual(AIFY_AGENT_SOURCE, "herdr:claude");
});

test("rename passes the label positionally, the way the CLI actually takes it", () => {
  // DRIVEN BY A REAL DEFECT: `herdr pane rename <pane> --label <x>` does not set <x>; it sets the
  // literal string "--label <x>", and that string was persisted into a real session.json.
  const label = paneLabel({ wrapper: "hermes-aify", record: "zz9" });
  assert.deepEqual(renamePaneArgv({ paneId: "w1:p7", label }), ["pane", "rename", "w1:p7", label]);
  assert.ok(!renamePaneArgv({ paneId: "w1:p7", label }).includes("--label"));
});

test("renaming refuses a label this module does not own", () => {
  // A wrapper that could set an arbitrary label could quietly adopt somebody else's pane.
  assert.throws(() => renamePaneArgv({ paneId: "w1:p7", label: "scratch" }), /does not own/);
  assert.throws(() => reportAgentArgv({ paneId: "nope", wrapper: "claude-aify" }), /pane id/);
});
