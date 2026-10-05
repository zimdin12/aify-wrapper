#!/usr/bin/env node
// claude-aify's user arguments are never read as more channel names.
//
// `--dangerously-load-development-channels <servers...>` takes every word after it until the next flag:
// measured on Claude Code 2.1.286 (dashboard-manager, 2026-10-01), `--dangerously-load-development-channels
// server:x PROMPT` swallows the prompt. The launcher puts `--settings <file>`, which takes one value,
// straight after the channel, and that is what keeps a bare prompt with `--safe` (no permission flag) out
// of it. Nothing else holds that order, so this does. Executed to a stub claude that records its argv.

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

for (const args of [["--safe", "do x"], ["--aify-agent", "lead", "--safe", "-p", "do x"], ["do x"]]) {
  test(`claude-aify ${args.join(" ")}: the channel's value is followed by a one-value flag, then the user's words`, () => {
    const { run, args: argv } = launch("claude", args);
    assert.equal(run.status, 0, run.stderr);
    const channel = argv.indexOf("--dangerously-load-development-channels");
    assert.equal(channel, 0, argv.join(" "));
    assert.match(argv[1], /^server:/);
    assert.equal(argv[2], "--settings", `the word after the channel is ${argv[2]}: ${argv.join(" ")}`);
    assert.deepEqual(argv.slice(-args.filter((a) => !["--safe", "--aify-agent", "lead"].includes(a)).length),
      args.filter((a) => !["--safe", "--aify-agent", "lead"].includes(a)), "the user's words arrive last and whole");
  });
}
