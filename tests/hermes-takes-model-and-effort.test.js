#!/usr/bin/env node
// hermes-aify hands its agent's model to hermes as HERMES_INFERENCE_MODEL and its effort to aify-comms'
// delivery loop as AIFY_HERMES_SESSION_EFFORT (P0 C9; review of P6, R1).
//
// A sealed hermes 0.21.5 gateway host built a new session on HERMES_INFERENCE_MODEL, and took a
// session-scoped `config.set reasoning`; hermes has no launch-time effort lever on the gateway path
// (aify-comms docs/superpowers/plans/evidence/2026-10-01-p6/hermes-model-probe.mjs). The loop that sets
// it per session is aify-comms' (mcp/stdio/hermes-session-effort.mjs).
//
// EXECUTED on the launcher's plain path (`hermes-aify chat`), to a stub hermes that records its
// environment. The two variables are exported after the agent is resolved and before the launcher
// chooses a path, so the gateway host and the delivery loop it spawns on the other path inherit the same
// values; that path is not run here, because it starts a gateway host.

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const definition = (over = {}) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "hermes",
  mode: "resident", workspace: "C:/work", model: "anthropic/claude-sonnet-4.6", effort: "high", instructions: "", env: {},
  herdrSpace: true, ...over } });
const run = (args, options) => launch("hermes", ["--aify-agent", "lead", ...args, "chat"], options);

test("THE DEFINITION'S model seeds hermes, and its effort goes to the loop", () => {
  const { run: r, started } = run([], { definitions: { lead: definition() } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT, started.AIFY_AGENT_ROLE],
    ["anthropic/claude-sonnet-4.6", "high", "reviewer"]);
});

test("A MANAGED LAUNCH's values are used; it reads no file", () => {
  const { run: r, started } = run([], { definitions: { lead: "{ not json" },
    env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-managed", AIFY_MANAGED_EFFORT: "low" } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT], ["m-managed", "low"]);
});

test("AIFY_MANAGED_* beats the definition on a launch that does read it", () => {
  const { run: r, started } = run([], { definitions: { lead: definition() }, env: { AIFY_MANAGED_MODEL: "m-env", AIFY_MANAGED_EFFORT: "low" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT], ["m-env", "low"]);
});

test("THE OPERATOR'S OWN model or effort is theirs: -m, HERMES_INFERENCE_MODEL, --reasoning", () => {
  const flagged = run(["-m", "flag/model", "--reasoning", "max"], { definitions: { lead: definition() } });
  assert.equal(flagged.run.status, 0, flagged.run.stderr);
  assert.deepEqual([flagged.started.HERMES_INFERENCE_MODEL, flagged.started.AIFY_HERMES_SESSION_EFFORT], [undefined, ""]);
  const env = run([], { definitions: { lead: definition() }, env: { HERMES_INFERENCE_MODEL: "env/model" } });
  assert.equal(env.started.HERMES_INFERENCE_MODEL, "env/model");
});

test("CONTROL: no definition sets nothing, and an inherited effort never applies", () => {
  const { run: r, started } = run([], { env: { AIFY_HERMES_SESSION_EFFORT: "inherited" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT], [undefined, ""]);
});
