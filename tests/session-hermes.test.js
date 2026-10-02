#!/usr/bin/env node
// The hermes config entries for the servers opted into every session (lib/session-hermes.mjs).
//
// Each refusal is the verb's own loop, not shared code, so each has its test and its control here. The expected entry
// is written out by hand, so this cannot agree with a wrong value the verb builds.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRegistry } from "../lib/registry.mjs";
import { OWNER, OWNER_KEY, sessionHermesEntries } from "../lib/session-hermes.mjs";
import { forwardingOf, isPlainKey } from "../lib/session-codex.mjs";

const DASHBOARD = {
  endpoint: "http://127.0.0.2:9700",
  credentialRef: "aify-dashboard.key",
  sessionInject: { mcp: true },
  mcp: [{ name: "aify-dashboard", command: "node", args: ["--experimental-strip-types", "C:/d b/bridge/main.ts", "serve"] }],
};
const COMMS = { endpoint: "http://127.0.0.2:1", mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }] };
const parsed = (services) => {
  const result = parseRegistry(JSON.stringify({ version: 1, services: { "aify-comms": COMMS, ...services } }));
  assert.equal(result.ok, true, result.errors.join("; "));
  return result.registry;
};
const withServer = (server) => parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "aify-dashboard", command: "node", args: [], ...server }] } });

test("an opted-in server becomes one entry: its command and args, every forwarded name as ${NAME}, and our mark", () => {
  const result = sessionHermesEntries(parsed({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } }));
  assert.equal(result.ok, true, result.problems?.join("; "));
  assert.deepEqual(result.entries, [{
    name: "aify-dashboard",
    value: {
      command: "node",
      args: ["--experimental-strip-types", "C:/d b/bridge/main.ts", "serve"],
      env: { AIFY_AGENT_ID: "${AIFY_AGENT_ID}", AIFY_DASHBOARD_URL: "${AIFY_DASHBOARD_URL}" },
      "x-aify-owner": "aify-wrapper",
    },
  }]);
  assert.deepEqual([OWNER_KEY, OWNER], ["x-aify-owner", "aify-wrapper"]);
});

test("with nothing opted in there are no entries, and a service that did not opt in is never one", () => {
  // COMMS is in every registry here and never opts in, so this is also the control for the test above.
  assert.deepEqual(sessionHermesEntries(parsed({})), { ok: true, entries: [] });
});

test("${ in a command or an argument is refused, because hermes would expand it", () => {
  // The bug this catches: hermes expanded an argument `${HOME}` to the home directory (probe2.txt), so a literal one
  // reaches the server as something else, with exit 0.
  for (const server of [{ args: ["--x=${HOME}"] }, { command: "${NODE}" }]) {
    const result = sessionHermesEntries(withServer(server));
    assert.equal(result.ok, false, JSON.stringify(server));
    assert.match(result.problems.join("\n"), /"\$\{" in its command or arguments/);
  }
  // The control: a `$` that opens no brace is not refused.
  assert.equal(sessionHermesEntries(withServer({ args: ["--price=$5"] })).ok, true);
});

test("a server name or variable name that is not plain is refused, with the name in the reason", () => {
  // A dot in a server name would be another level of `mcp_servers.<name>`; a dash in a variable name is no variable.
  const dotted = sessionHermesEntries(withServer({ name: "a.b" }));
  assert.equal(dotted.ok, false);
  assert.match(dotted.problems.join("\n"), /"a\.b"/);
  const dashed = sessionHermesEntries(parsed({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["NOT-A-NAME"] } }));
  assert.equal(dashed.ok, false);
  assert.match(dashed.problems.join("\n"), /"NOT-A-NAME"/);
});

test("the agent id variable is refused while any service keeps a key in it, in any case", () => {
  // Hermes forwards the inherited value, so a neighbour's credential would reach the server as the agent id.
  const held = sessionHermesEntries(parsed({ "aify-comms": { ...COMMS, keyEnv: ["aify_agent_id"] }, "aify-dashboard": DASHBOARD }));
  assert.equal(held.ok, false);
  assert.match(held.problems.join("\n"), /"AIFY_AGENT_ID".*aify-comms/);
  // The control: a key under a distinct name beside it is accepted.
  assert.equal(sessionHermesEntries(parsed({ "aify-comms": { ...COMMS, keyEnv: ["COMMS_KEY"] }, "aify-dashboard": DASHBOARD })).ok, true);
});

test("a command or argument UTF-8 cannot carry is refused, and a paired surrogate is ordinary text", () => {
  const lone = sessionHermesEntries(withServer({ args: [`a${String.fromCharCode(0xd800)}b`] }));
  assert.equal(lone.ok, false);
  assert.match(lone.problems.join("\n"), /UTF-8/);
  const emoji = String.fromCodePoint(0x1f600);
  const paired = sessionHermesEntries(withServer({ args: [`a${emoji}b`] }));
  assert.equal(paired.ok, true);
  assert.deepEqual(paired.entries[0].value.args, [`a${emoji}b`]);
});

test("the forwarding rule is one rule for every runtime, and names the runtime that refused", () => {
  // forwardingOf and isPlainKey are shared with session-codex.mjs; the verbs' own tests above reach them through the
  // verbs, and this names them directly.
  // Unparsed services, because the parse already refuses this registry (0d4622f); the rule is checked beneath it.
  const services = { "aify-comms": { keyEnv: ["SHARED_KEY"], endpointEnv: [] }, "aify-dashboard": { endpointEnv: ["shared_key"] } };
  const { forwarded, problems } = forwardingOf(services)("aify-dashboard", "hermes");
  assert.deepEqual(forwarded, ["AIFY_AGENT_ID", "shared_key"]);
  assert.match(problems.join("\n"), /"shared_key" would be forwarded, and aify-comms keeps a key in it/);
  assert.deepEqual(forwardingOf(parsed({}).services)("aify-comms", "hermes").problems, []);
  assert.deepEqual(["a.b", "a b", "a-b_1"].map(isPlainKey), [false, false, true]);
});
