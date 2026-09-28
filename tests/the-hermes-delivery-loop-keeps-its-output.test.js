#!/usr/bin/env node
// The hermes delivery loop's output is kept, in a file per agent, instead of thrown away.
//
// 2026-09-28: pc-manager's loop ran 18 days beside a gateway with no TUI, the agent reading `online`
// throughout, and its output went to /dev/null, so nothing could say which path it was stuck on (the
// likeliest, a 403 on a stale gateway token, was reconstructed from the code and a live probe). This
// reads the launcher line that starts the loop; the template is the artifact install.sh renders.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "wrappers", "hermes-aify.sh.in"), "utf8");
const loopLines = TEMPLATE.split("\n").filter((line) => /^\s*nohup node "\$AIFY_HERMES_MANAGED_HOST_JS" run /.test(line));

test("CONTROL: the launcher starts the delivery loop on exactly one line", () => {
  assert.equal(loopLines.length, 1, loopLines.join("\n"));
});

test("the loop's output goes to a per-agent log, not /dev/null", () => {
  const [line] = loopLines;
  assert.ok(!/\/dev\/null/.test(line), `the loop's output is discarded: ${line}`);
  assert.match(line, />"\$\{TMPDIR:-\/tmp\}\/aify-hermes-loop-\$HERMES_AIFY_AGENT_ID\.log" 2>&1 &$/,
    "stdout and stderr go to one file per agent, started fresh each launch");
});
