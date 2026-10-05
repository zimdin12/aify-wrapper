#!/usr/bin/env node
// The runtime-exited report reaches the bridge's script with Git Bash's path rewriting switched off.
//
// THE SAME DEFECT AS THE RESUME LOOKUP (aify-comms v0.7.1 review, W04), one call further away: every
// launcher hands `aify-runtime-exited.sh` the bridge directory as rendered, MSYS-style on Windows, and
// the helper passed `<dir>/agent-state-event.mjs` to native node. With MSYS_NO_PATHCONV=1 node looked
// for `C:/c/Users/...`, and the turn-end that clears a dead agent's `working` was never sent.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "bin", "aify-runtime-exited.sh");
const WIN = process.platform === "win32";
const BASH = WIN
  ? execFileSync("bash", ["-lc", 'cygpath -w "$(command -v bash)"'], { encoding: "utf8" }).trim()
  : "bash";
const shellPath = (p) => (WIN ? execFileSync(BASH, ["-c", 'cygpath -u "$1"', "_", p], { encoding: "utf8" }).trim() : p);

function report({ rewriting }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-exit-report-"));
  const events = path.join(dir, "events");
  fs.writeFileSync(path.join(dir, "agent-state-event.mjs"),
    'import fs from "node:fs"; fs.appendFileSync(process.env.STUB_EVENTS, process.argv.slice(2).join(" ") + "\\n");\n');
  const env = {
    ...process.env,
    AIFY_AGENT_ID: "exit-report-probe",
    STUB_EVENTS: events,
    ...(rewriting ? {} : { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }),
  };
  const run = spawnSync(BASH, [shellPath(HELPER), shellPath(dir)], { encoding: "utf8", env, timeout: 30_000 });
  const sent = fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim() : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, sent };
}

test("the turn-end is sent with MSYS path rewriting off", () => {
  const { run, sent } = report({ rewriting: false });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(sent, "turn-end", "node never opened the bridge's agent-state-event.mjs");
});

test("CONTROL: and with it on, as in an ordinary Git Bash", () => {
  assert.equal(report({ rewriting: true }).sent, "turn-end");
});
