#!/usr/bin/env node
// Turning a recorded argv back into typed text, and refusing when that cannot be done safely.
//
// THE DEFECT THIS EXISTS FOR, measured against a real Herdr after review pointed at it:
//
//     herdr pane run w1:p1 echo --flag "be terse"   ->   the pane printed   be
//                                                                           terse
//
// `pane run` TYPES its arguments into the pane's shell, and the boundary was gone. A wrapper started
// as `claude-aify --append-system-prompt "be terse"` would have come back after a reboot as two
// arguments -- an agent that looks right and is configured differently.
//
// AND THE ORIGINAL END-TO-END PROOF COULD NOT HAVE CAUGHT IT: it replayed
// `echo RESTORED_BY_THE_PLUGIN`, a single bare token, which is the one shape that cannot expose
// quoting. The control below is deliberately that exact shape, so this file records both.

import assert from "node:assert/strict";
import { test } from "node:test";

import { launcherName, quoteArgument, replayCommand, replayableArgv, restoreArgv } from "../lib/herdr-replay.mjs";

test("the shape the original proof used still works, and is the control", () => {
  assert.deepEqual(replayCommand(["echo", "RESTORED_BY_THE_PLUGIN"]), {
    ok: true,
    text: "echo RESTORED_BY_THE_PLUGIN",
    why: null,
  });
});

test("an argument containing a space keeps its boundary", () => {
  const replay = replayCommand(["claude-aify", "--append-system-prompt", "be terse"]);
  assert.equal(replay.ok, true, replay.why);
  assert.equal(replay.text, 'claude-aify --append-system-prompt "be terse"');
  // Double quotes mean the same thing in PowerShell, cmd and bash, which is the whole reason this
  // is the chosen quoting and not a shell-specific one.
});

test("ordinary wrapper invocations pass through unquoted", () => {
  assert.equal(replayCommand(["claude-aify"]).text, "claude-aify");
  assert.equal(replayCommand(["claude-aify", "--resume"]).text, "claude-aify --resume");
  assert.equal(replayCommand(["/c/Users/x/.local/bin/claude-aify", "--model=opus"]).text,
    "/c/Users/x/.local/bin/claude-aify --model=opus");
});

test("a newline is refused, because it would start a SECOND command in the operator's shell", () => {
  // The ledger is a file on disk; an argv smuggled into it would otherwise be typed into a live
  // terminal at every Herdr start.
  const replay = replayCommand(["claude-aify\nnet user hacker P@ss /add", "--resume"]);
  assert.equal(replay.ok, false);
  assert.match(replay.why, /control character/);
  assert.equal(replay.text, null);
  for (const bad of ["\r", "\u0000", "\u001b"]) {
    assert.equal(quoteArgument(`x${bad}y`).ok, false, `${JSON.stringify(bad)} was accepted`);
  }
});

test("characters that mean different things in the three shells are refused, not guessed", () => {
  // `$` expands in bash and PowerShell, `%` in cmd, `!` under delayed expansion, a backtick is
  // PowerShell's escape, and `"` ends the quoting this relies on.
  for (const bad of ['say "hi"', "cost $5", "50%", "a`b", "wow!", "back\\slash"]) {
    const replay = replayCommand(["claude-aify", bad]);
    assert.equal(replay.ok, false, `${JSON.stringify(bad)} was replayed rather than refused`);
    assert.match(replay.why, /different things|control character/);
  }
});

test("a refusal names the offending argument, so the log says which one", () => {
  const replay = replayCommand(["claude-aify", "--flag", "a $HOME b"]);
  assert.equal(replay.ok, false);
  assert.match(replay.why, /\$HOME/);
});

test("an empty argv and an empty argument are both refused", () => {
  assert.equal(replayCommand([]).ok, false);
  assert.equal(replayCommand(null).ok, false);
  assert.equal(quoteArgument("").ok, false);
  // All or nothing: one bad argument refuses the whole line, because a command with an argument
  // dropped is worse than a command not replayed.
  assert.equal(replayCommand(["claude-aify", "ok", "bad $x"]).ok, false);
});

test("a restore replays the recorded argv as an AUTOMATIC start, so a live instance refuses it", () => {
  // A pane is a terminal: without this the launcher reads a restore as a person and replaces the agent.
  assert.deepEqual(restoreArgv(["claude-aify", "--aify-agent", "a"]), ["claude-aify", "--aify-start-intent=start", "--aify-agent", "a"]);
  assert.deepEqual(restoreArgv(["claude-aify", "--aify-start-intent=replace", "--resume"]), ["claude-aify", "--aify-start-intent=start", "--resume"],
    "a replayed command carried two intents, or kept the recorded replace");
  assert.deepEqual(restoreArgv([]), []);
  assert.equal(replayCommand(restoreArgv(["claude-aify"])).ok, true, "the flag must survive the quoting any pane shell needs");
});

test("a pane replays its launcher by NAME, so a Windows shim's backslashed path can be claimed and restored", () => {
  // THE MEASURED CASE: `claude-aify.cmd` runs the script as this path, and every such claim was refused.
  const windows = String.raw`C:\Users\Administrator\.local\bin\claude-aify`;
  assert.equal(replayCommand([windows, "--aify-agent", "a"]).ok, false, "control: the path itself is not replayable");
  assert.equal(launcherName(windows), "claude-aify");
  assert.deepEqual(replayableArgv({ wrapper: windows, argv: [windows, "--aify-agent", "a"] }), ["claude-aify", "--aify-agent", "a"]);
  assert.equal(replayCommand(replayableArgv({ wrapper: "claude-aify", argv: [windows, "--aify-agent", "a"] })).text, "claude-aify --aify-agent a");
  assert.deepEqual(replayableArgv({ wrapper: "claude-aify", argv: ["/home/x/.local/bin/claude-aify", "--resume"] }), ["claude-aify", "--resume"]);
  // Only the wrapper itself is renamed: an argv led by anything else keeps what it was, and so does an argument.
  assert.deepEqual(replayableArgv({ wrapper: "claude-aify", argv: ["/usr/bin/bash", windows] }), ["/usr/bin/bash", windows]);
  assert.deepEqual(replayableArgv({ wrapper: "codex-aify", argv: [windows] }), [windows]);
  assert.deepEqual(replayableArgv({ wrapper: "", argv: ["claude-aify"] }), ["claude-aify"]);
  assert.deepEqual(replayableArgv({ wrapper: "claude-aify", argv: [] }), []);
  // What makes a replay unsafe still refuses it: renaming the launcher is not a way around the quoting.
  assert.equal(replayCommand(replayableArgv({ wrapper: "claude-aify", argv: [windows, "a $HOME b"] })).ok, false);
});
