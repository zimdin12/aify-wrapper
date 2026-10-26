#!/usr/bin/env node
// The rendered claude-aify passes Claude a settings file whose UserPromptSubmit runs the turn-start runner, synchronously
// (its stdout is the context it adds), beside the session capture that was already there.
//
// It runs the real installer's render and the real launcher with a stub `claude` that keeps the settings file it was
// given, then parses that file and runs the registered runner command the way Claude would.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { emptyRegistry } from "./sealed-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";

test("THE LAUNCHER'S SETTINGS run the turn-start runner on UserPromptSubmit, synchronously, beside the session capture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-turn-start-launch-"));
  try {
    const out = path.join(dir, "out"), stubs = path.join(dir, "stubs"), home = path.join(dir, "home"), bridge = path.join(dir, "bridge");
    for (const d of [out, stubs, home, bridge]) fs.mkdirSync(d, { recursive: true });
    const rendered = spawnSync("bash", [INSTALL, "--registry", emptyRegistry(), "--client", "claude", "--endpoint", NOWHERE,
      "--render-only", out, "--bridge-dir", bridge], { encoding: "utf8", timeout: 120_000 });
    assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

    // A host aify-comms' installer has run on: its channel server is configured and its script is in the bridge, so the
    // launcher has a channel to load (a configured server whose script is missing is refused, lib/channel-route.mjs).
    fs.writeFileSync(path.join(bridge, "claude-channel.js"), "// the installed channel server\n");
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "aify-comms-channel": { command: "node", args: [path.join(bridge, "claude-channel.js")] } } }));
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(path.join(stubs, "claude"), [
      "#!/bin/sh",
      'while [ $# -gt 0 ]; do',
      `  if [ "$1" = "--settings" ]; then cp "$2" '${settings.split(path.sep).join("/")}'; fi`,
      "  shift",
      "done",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
    // The stub `claude` first, then this process's own PATH, in the platform's own form: Git Bash converts it.
    const env = { PATH: [stubs, process.env.PATH].join(path.delimiter),
      HOME: home, USERPROFILE: home, HARNESS_IDENTITY: "probe-agent", SystemRoot: process.env.SystemRoot, TMPDIR: dir, TEMP: dir, TMP: dir };
    const run = spawnSync("bash", [path.join(out, "claude-aify")], { encoding: "utf8", env, timeout: 60_000 });
    assert.equal(run.status, 0, `launcher failed: ${run.stdout}\n${run.stderr}`);
    assert.ok(fs.existsSync(settings), `no --settings was passed:\n${run.stderr}`);

    const config = JSON.parse(fs.readFileSync(settings, "utf8"));
    const commands = config.hooks.UserPromptSubmit.flatMap((group) => group.hooks);
    const runner = commands.filter((hook) => hook.command.includes("aify-turn-start.mjs"));
    assert.equal(runner.length, 1, `the runner is registered once: ${JSON.stringify(commands)}`);
    assert.notEqual(runner[0].async, true, "the runner must be synchronous: its output is the context");
    assert.ok(commands.some((hook) => hook.command.includes("claude-session-hook.js")), "the session capture is still registered");
    // And at session start, which Claude Code fires again after a compaction, beside what that entry already ran.
    const starting = config.hooks.SessionStart.flatMap((group) => group.hooks);
    const briefed = starting.filter((hook) => hook.command.includes("aify-turn-start.mjs"));
    assert.equal(briefed.length, 1, `the runner is registered once at SessionStart: ${JSON.stringify(starting)}`);
    assert.notEqual(briefed[0].async, true, "the runner must be synchronous: its output is the context");
    assert.ok(starting.some((hook) => hook.command.includes("agent-state-event.mjs")), "the lifetime report is still registered");

    // Run the registered command as Claude would: with no agent id it adds nothing and exits 0.
    const fired = spawnSync("sh", ["-c", runner[0].command], { input: JSON.stringify({ session_id: "s", cwd: dir }), encoding: "utf8",
      env: { ...env, AIFY_AGENT_ID: "", AIFY_SERVICE_REGISTRY: emptyRegistry() }, timeout: 10_000 });
    assert.equal(fired.status, 0, fired.stderr);
    assert.equal(fired.stdout, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
