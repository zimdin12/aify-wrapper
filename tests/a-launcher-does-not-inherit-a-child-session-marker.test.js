#!/usr/bin/env node
// A launcher must not pass another session's CHILD marker to the agent it starts.
//
// WHAT THE MARKER DOES. `CLAUDE_CODE_CHILD_SESSION` tells Claude Code it is a nested session, and it
// responds by not writing a transcript: no history on disk, and nothing to `--resume` from. The name
// being PRESENT is the signal, so an empty value would keep the behaviour while looking fixed.
//
// WHY A LAUNCHER IS WHERE IT LEAKS. The variable is set inside a running Claude Code session. A human
// starting an agent types the launcher into whatever shell they are in -- and on a machine that runs
// agents, that is very often a shell inside a Claude Code session. Every agent started from there
// loses its transcript, and the only sign is a one-line banner the operator has to notice and decode.
//
// MEASURED, not anticipated: on 2026-08-26 the operator's own resident session was running with
// `CLAUDE_CODE_CHILD_SESSION=1` and its transcript off. aify-comms already strips this on the SPAWN
// path (`child-env-hygiene.mjs`), which is why managed agents are covered and this one was not: a
// resident launcher has no spawner to clean its environment.
//
// WHAT THIS TEST CAN AND CANNOT DO, said rather than implied. The assertion reads the RENDERED
// launcher. Running it to observe the variable would mean starting a real coding agent -- `--check`
// exits before the launch, so it cannot see the environment the agent would receive. So this pins the
// unset being present and being reached BEFORE the exec, which is the part that can go wrong in an
// edit, and it does not claim to have watched a live session lose the marker.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(HERE, "..", "install.sh");
const NOWHERE = "http://127.0.0.2:1";

function renderClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-wrapper-marker-"));
  execFileSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", dir], {
    encoding: "utf8",
  });
  return dir;
}

test("the rendered claude launcher unsets the child-session marker", () => {
  const dir = renderClaude();
  try {
    const text = fs.readFileSync(path.join(dir, "claude-aify"), "utf8");
    assert.match(
      text, /^unset CLAUDE_CODE_CHILD_SESSION$/m,
      "the launcher no longer clears the inherited marker, so every agent started from a Claude Code "
        + "shell will silently run with its transcript off",
    );
    // UNSET, NOT EMPTIED. Claude Code keys on the name being present, so `export X=""` would leave the
    // behaviour in place while reading as a fix in the diff.
    assert.doesNotMatch(
      text, /CLAUDE_CODE_CHILD_SESSION=/,
      "the marker is being ASSIGNED rather than unset; an empty value still disables the transcript",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the unset happens BEFORE the launcher starts the agent", () => {
  // Order is the whole of it. An unset below the launch line is dead code that still reads as a fix.
  const dir = renderClaude();
  try {
    const lines = fs.readFileSync(path.join(dir, "claude-aify"), "utf8").split("\n");
    const unsetAt = lines.findIndex((l) => l.trim() === "unset CLAUDE_CODE_CHILD_SESSION");
    // The launcher does NOT `exec` -- it runs `claude ...` and exits with its status, so a trap can
    // clean up its temp config. My first version anchored on `exec` and its own anti-vacuity
    // assertion caught that: a scan with no anchor cannot judge order, and would have failed for a
    // reason unrelated to the code under test.
    const launchAt = lines.findIndex((l) => /^\s*claude\s+--dangerously-load-development-channels\b/.test(l));
    assert.ok(unsetAt >= 0, "no unset in the rendered launcher");
    assert.ok(launchAt >= 0, "this test found no launch line, so it cannot judge order -- the scan is broken");
    assert.ok(
      unsetAt < launchAt,
      `the unset is at line ${unsetAt + 1} and the launch at ${launchAt + 1}: it runs too late to matter`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
