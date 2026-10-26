#!/usr/bin/env node
// The hermes delivery loop's output is kept, in a file per agent, instead of thrown away.
//
// 2026-09-28: pc-manager's loop was found beside a gateway with no TUI (started 2026-09-25), the agent
// still reading `online`, and its output had gone to /dev/null, so nothing could say which path it was
// on. A reject-forever path was found in the code afterwards; whether this loop was on it is not known. This
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

test("the loop starts with the gateway the launcher verified already in its environment (0.9.10 review)", () => {
  // The loop's bring-up takes AIFY_HERMES_GATEWAY_URL instead of asking aify-env again: a second ask whose probe
  // missed a busy gateway would end the one the TUI uses. Exported after the loop starts, it reaches only the TUI.
  const exportAt = TEMPLATE.split("\n").findIndex((line) => /^\s*export AIFY_HERMES_GATEWAY_URL="\$HERMES_TUI_WS_URL"$/.test(line));
  const loopAt = TEMPLATE.split("\n").indexOf(loopLines[0]);
  assert.ok(exportAt >= 0, "control: the launcher exports the verified gateway url");
  assert.ok(exportAt < loopAt, `the url is exported on line ${exportAt + 1}, after the loop starts on line ${loopAt + 1}`);
});
