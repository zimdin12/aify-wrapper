#!/usr/bin/env node
// A shell that belongs to a running agent session names no agent (lib/inherited-session.mjs,
// bin/aify-inherited-session.sh).
//
// THE INCIDENT, 2026-09-15: a Herdr server started from inside comms-tech-lead's Claude Code session gave every
// pane that agent's id and conversation. A bare `claude-aify` typed into one started as comms-tech-lead and
// replaced the live one. The launchers' end of it is in a-launcher-holds-the-agent-lease.test.js; this holds
// the helper and its two lists, and the pane claim that the same day's launches were all refused.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SESSION_CARRIERS, SESSION_MARKERS, withoutAgentSession } from "../lib/inherited-session.mjs";
import { HerdrPaneLedger } from "../lib/herdr-restore.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "bin", "aify-inherited-session.sh");
const PANE = path.join(ROOT, "bin", "aify-herdr-pane.mjs");
const WIN = process.platform === "win32" && "bash here may be WSL's, and the stub herdr is a shell script Windows cannot spawn by path";

/** The value of one `NAME="a b c"` line in the helper, as a list. */
function shellList(name) {
  const line = fs.readFileSync(HELPER, "utf8").split("\n").find((l) => l.startsWith(`${name}="`));
  assert.ok(line, `control: ${name} is found in the helper`);
  return line.slice(name.length + 2, -1).split(" ");
}

test("the shell helper and lib/inherited-session.mjs name the same markers and carriers", () => {
  assert.deepEqual(shellList("AIFY_SESSION_MARKERS"), [...SESSION_MARKERS]);
  assert.deepEqual(shellList("AIFY_SESSION_CARRIERS"), [...SESSION_CARRIERS]);
  // A marker the service does not strip from a managed launch would make that worker forget its identity.
  assert.ok(!SESSION_MARKERS.includes("CLAUDECODE"), "CLAUDECODE reaches managed workers, so it cannot mark a session");
  assert.ok(!SESSION_CARRIERS.includes("AIFY_AGENT_LEASE"), "the lease is what refuses a launch inside its own live instance");
});

test("withoutAgentSession drops every marker and carrier, in any case, and nothing else", () => {
  const session = Object.fromEntries([...SESSION_MARKERS, ...SESSION_CARRIERS, "CLAUDECODE"].map((name) => [name, "x"]));
  const kept = { PATH: "/usr/bin", HOME: "/h", AIFY_COMMS_URL: "http://127.0.0.1:8800", AIFY_API_KEY: "k", HARNESS_IDENTITY: "host-given" };
  assert.deepEqual(withoutAgentSession({ ...session, ...kept, aify_agent_id: "lower" }), kept);
  assert.deepEqual(withoutAgentSession(undefined), {});
});

/** Source the helper under `set -euo pipefail`, run it, and report what is left of the names asked about. */
function forget(env) {
  const names = ["AIFY_AGENT_ID", "CLAUDE_SESSION_ID", "AIFY_SESSION_MODE", "AIFY_AGENT_LEASE", "PATH_KEPT"];
  const script = [
    "set -euo pipefail",
    `. '${HELPER}'`,
    "aify_forget_inherited_session",
    ...names.map((name) => `printf '%s=%s\\n' ${name} "\${${name}-<unset>}"`),
  ].join("\n");
  const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, PATH_KEPT: "yes", ...env } });
  assert.equal(run.status, 0, run.stderr);
  return { left: Object.fromEntries(run.stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))), said: run.stderr };
}

test("inside a session the helper unsets what named it and keeps the lease; outside one it changes nothing", { skip: WIN }, () => {
  const identity = { AIFY_AGENT_ID: "comms-tech-lead", CLAUDE_SESSION_ID: "651b895f", AIFY_SESSION_MODE: "resident" };

  for (const marker of [{ AIFY_AGENT_LEASE: "62512" }, { CLAUDE_CODE_CHILD_SESSION: "1" }]) {
    const { left, said } = forget({ ...identity, ...marker });
    assert.deepEqual([left.AIFY_AGENT_ID, left.CLAUDE_SESSION_ID, left.AIFY_SESSION_MODE], ["<unset>", "<unset>", "<unset>"], JSON.stringify(marker));
    assert.equal(left.PATH_KEPT, "yes");
    assert.equal(left.AIFY_AGENT_LEASE, marker.AIFY_AGENT_LEASE ?? "<unset>", "the lease is kept for the nested refusal");
    assert.match(said, new RegExp(`${Object.keys(marker)[0]} is set.*ignored: AIFY_AGENT_ID AIFY_SESSION_MODE CLAUDE_SESSION_ID\.`), "it says what it ignored");
  }

  // CONTROLS: a clean shell, and an empty lease (what a lease watch runs with), keep an identity a person gave.
  for (const clean of [{}, { AIFY_AGENT_LEASE: "" }]) {
    const { left, said } = forget({ ...identity, ...clean });
    assert.deepEqual([left.AIFY_AGENT_ID, left.CLAUDE_SESSION_ID], ["comms-tech-lead", "651b895f"], JSON.stringify(clean));
    assert.equal(said, "", "a clean shell is told nothing");
  }
});

test("a pane launched through the Windows shim is CLAIMED, and recorded by name", { skip: WIN }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-shim-claim-"));
  const calls = path.join(dir, "herdr-calls");
  const herdr = path.join(dir, "herdr");
  fs.writeFileSync(herdr, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${calls}'`,
    `if [ "$1 $2" = "pane list" ]; then printf '%s' '{"result":{"panes":[{"pane_id":"w1:p2","terminal_id":"term-1"}]}}'; fi`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const ledger = path.join(dir, "panes.json");
  const env = { PATH: process.env.PATH, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: herdr, AIFY_HERDR_LEDGER: ledger };
  const shim = String.raw`C:\Users\Administrator\.local\bin\claude-aify`;

  const run = spawnSync(process.execPath, [PANE, "claim", "--wrapper", shim, "--", shim, "--aify-agent", "general-manager"], { encoding: "utf8", env });
  assert.equal(run.stdout, "claimed\n", `the shim's launch was not claimed: ${run.stderr}`);
  const records = new HerdrPaneLedger({ file: ledger }).load().all();
  const [record] = records.values();
  assert.deepEqual([records.size, record.wrapper, record.argv], [1, "claude-aify", ["claude-aify", "--aify-agent", "general-manager"]]);
  assert.match(fs.readFileSync(calls, "utf8"), /pane report-agent w1:p2 --source herdr:aify --agent claude-aify /);

  // CONTROL: an argument no pane can replay is still refused, and nothing is recorded for it.
  const unsafe = spawnSync(process.execPath, [PANE, "claim", "--wrapper", shim, "--", shim, "--append-system-prompt", "a $HOME b"], { encoding: "utf8", env: { ...env, AIFY_HERDR_LEDGER: path.join(dir, "other.json") } });
  assert.equal(unsafe.stdout, "", "an unreplayable argument was claimed");
  assert.match(unsafe.stderr, /cannot be replayed safely/);
});
