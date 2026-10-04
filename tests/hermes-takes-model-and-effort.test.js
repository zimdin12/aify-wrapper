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
// environment and argv. The two variables are exported after the agent is resolved and before the
// launcher chooses a path, so the gateway host and the delivery loop it spawns on the other path inherit
// the same values; that path is not run here, because it starts a gateway host.
//
// The plain `chat` itself is the classic CLI, which reads neither: it gets both as its own `-m` and
// `--reasoning` (review of P6r, L1: it was started with `chat` alone).

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const definition = (over = {}) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "hermes",
  mode: "resident", workspace: "C:/work", model: "anthropic/claude-sonnet-4.6", effort: "high", instructions: "", env: {},
  herdrSpace: true, ...over } });
const run = (args, options) => launch("hermes", ["--aify-agent", "lead", ...args, "chat"], options);

test("THE DEFINITION'S model seeds hermes, and its effort goes to the loop", () => {
  const { run: r, started, args } = run([], { definitions: { lead: definition() } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT, started.AIFY_AGENT_ROLE],
    ["anthropic/claude-sonnet-4.6", "high", "reviewer"]);
  assert.deepEqual(args, ["chat", "-m", "anthropic/claude-sonnet-4.6", "--reasoning", "high"], "the plain chat consumes both");
});

test("A PLAIN CHAT keeps its own arguments after the agent's, and a non-chat command gets none", () => {
  const chat = launch("hermes", ["--aify-agent", "lead", "chat", "-q", "hi"], { definitions: { lead: definition() } });
  assert.equal(chat.run.status, 0, chat.run.stderr);
  assert.deepEqual(chat.args, ["chat", "-m", "anthropic/claude-sonnet-4.6", "--reasoning", "high", "-q", "hi"]);
  const other = launch("hermes", ["--aify-agent", "lead", "model", "list"], { definitions: { lead: definition() } });
  assert.equal(other.run.status, 0, other.run.stderr);
  assert.deepEqual(other.args, ["model", "list"]);
});

test("THE CHAT IS FOUND PAST HERMES' OWN TOP-LEVEL FLAGS, as its command_argv finds it (review of P6r2, L1)", () => {
  const M = "anthropic/claude-sonnet-4.6";
  for (const [given, expected] of [
    [["-m", "own/model", "chat"], ["-m", "own/model", "chat", "--reasoning", "high"]],
    [["--provider", "p", "chat"], ["--provider", "p", "chat", "-m", M, "--reasoning", "high"]],
    [["-mown/model", "chat"], ["-mown/model", "chat", "--reasoning", "high"]],
    [["--provider=p", "chat", "-q", "hi"], ["--provider=p", "chat", "-m", M, "--reasoning", "high", "-q", "hi"]],
    // CONTROL: `chat` is the value of -m here, and there is no subcommand: nothing is added.
    [["-m", "chat"], ["-m", "chat"]],
  ]) {
    const { run: r, args } = launch("hermes", ["--aify-agent", "lead", ...given], { definitions: { lead: definition() } });
    assert.equal(r.status, 0, `${given.join(" ")}: ${r.stderr}`);
    assert.deepEqual(args, expected, given.join(" "));
  }
});

test("A MANAGED LAUNCH's values are used; it reads no file", () => {
  const { run: r, started } = run([], { definitions: { lead: "{ not json" },
    env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "m-managed", AIFY_MANAGED_EFFORT: "low" } });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT], ["m-managed", "low"]);
});

test("AIFY_MANAGED_* beats the definition on a launch that does read it", () => {
  const { run: r, started } = run([], { definitions: { lead: definition() }, env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_MODEL: "m-env", AIFY_MANAGED_EFFORT: "low" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT], ["m-env", "low"]);
});

test("THE OPERATOR'S OWN model or effort is theirs: -m and --reasoning on the command line", () => {
  const flagged = run(["-m", "flag/model", "--reasoning", "max"], { definitions: { lead: definition() } });
  assert.equal(flagged.run.status, 0, flagged.run.stderr);
  assert.deepEqual([flagged.started.HERMES_INFERENCE_MODEL, flagged.started.AIFY_HERMES_SESSION_EFFORT], [undefined, ""]);
  const own = launch("hermes", ["--aify-agent", "lead", "chat", "--reasoning", "max"], { definitions: { lead: definition() } });
  assert.deepEqual(own.args, ["chat", "-m", "anthropic/claude-sonnet-4.6", "--reasoning", "max"], "only the one not given is added");
});

test("A MODEL IN THE ENVIRONMENT does not beat the configured one, and fills in only when none is configured", () => {
  // A spawn's or a definition's variables arrive in the environment; HERMES_INFERENCE_MODEL there ran another
  // model while agent info showed the configured one (external review of 0.8.4, leftover from 0.8.1).
  for (const name of ["HERMES_INFERENCE_MODEL", "HERMES_MODEL"]) {
    const env = run([], { definitions: { lead: definition() }, env: { [name]: "env/model" } });
    assert.equal(env.run.status, 0, env.run.stderr);
    assert.deepEqual([env.started.HERMES_INFERENCE_MODEL, env.started.HERMES_MODEL],
      ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"], name);
  }
  const unset = run([], { definitions: { lead: definition({ model: "" }) }, env: { HERMES_INFERENCE_MODEL: "env/model" } });
  assert.equal(unset.started.HERMES_INFERENCE_MODEL, "env/model", "control: with nothing configured the environment's applies");
});

test("CONTROL: no definition sets nothing, and an inherited effort never applies", () => {
  const { run: r, started } = run([], { env: { AIFY_HERMES_SESSION_EFFORT: "inherited" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([started.HERMES_INFERENCE_MODEL, started.AIFY_HERMES_SESSION_EFFORT], [undefined, ""]);
});
