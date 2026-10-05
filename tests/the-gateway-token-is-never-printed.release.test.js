#!/usr/bin/env node
// hermes-aify never prints the managed gateway's bearer token, on its success line or its parse-failure line.
//
// THE DEFECT (2026-10-05, graph-tech-lead's spawn test). The launcher echoed the gateway host's whole answer,
// {port, token, wsUrl}, to stderr -- and the wsUrl carries the same token as `?token=`. A managed worker's stderr
// is its console, which console_tail and the dashboard serve, so anyone able to read a console could drive that
// agent's gateway. The answer itself is private IPC on stdout and stays whole: the TUI still needs the URL.
//
// EXECUTED: the rendered hermes-aify on its managed path (an agent id, no chat command), to a stub gateway host
// that answers with a SENTINEL token and a stub TUI that records its environment. Everything the launcher prints
// is searched for the sentinel; the TUI's gateway URL must still carry it (the control that the token was not
// simply lost).

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const SENTINEL = "SENTINEL-TOKEN-a1b2c3";

/** A gateway host that answers `ensure-host` with `answer`, and nothing else. */
const host = (answer) => [
  "if (process.argv[2] === 'ensure-host') process.stdout.write(" + JSON.stringify(`${answer}\n`) + ");",
  "",
].join("\n");

const run = (answer) => launch("hermes", ["--aify-agent", `token-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`], {
  bridgeFiles: { "hermes-managed-host.js": host(answer) },
});

test("THE SUCCESS LINE names the gateway without its token, and the TUI still gets the URL that carries it", () => {
  const answer = JSON.stringify({ port: 9999, token: SENTINEL, wsUrl: `ws://127.0.0.2:9999/api/ws?token=${SENTINEL}` });
  const { run: r, started } = run(answer);
  const printed = `${r.stdout}${r.stderr}`;
  assert.match(printed, /managed gateway host ready on port 9999/, `control: the success line was not reached:\n${printed}`);
  assert.ok(!printed.includes(SENTINEL), `the gateway token was printed:\n${printed}`);
  assert.ok(String(started.HERMES_TUI_GATEWAY_URL || "").includes(SENTINEL), "control: the TUI no longer gets the token it needs");
});

test("THE PARSE-FAILURE LINE names what came back without its token", () => {
  // No wsUrl to parse, but a token beside it, and the same token in a stray URL.
  const answer = JSON.stringify({ port: 9999, token: SENTINEL, note: `ws://x/?token=${SENTINEL}` });
  const { run: r } = run(answer);
  const printed = `${r.stdout}${r.stderr}`;
  assert.match(printed, /could not parse wsUrl/, `control: the parse-failure line was not reached:\n${printed}`);
  assert.notEqual(r.status, 0);
  assert.ok(!printed.includes(SENTINEL), `the gateway token was printed:\n${printed}`);
});

test("A TRUNCATED ANSWER prints no token either: the failure line shows no part of what came back", () => {
  // Review of 8668655, T4: a redaction keyed on the token's closing quote found none in a cut-off answer, and the
  // FATAL line printed the token whole.
  const { run: r } = run(`{"port":9999,"token":"${SENTINEL}`);
  const printed = `${r.stdout}${r.stderr}`;
  assert.match(printed, /could not parse wsUrl/, `control: the parse-failure line was not reached:\n${printed}`);
  assert.notEqual(r.status, 0);
  assert.ok(!printed.includes(SENTINEL.slice(0, 8)), `part of the gateway token was printed:\n${printed}`);
});
