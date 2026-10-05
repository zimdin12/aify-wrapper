#!/usr/bin/env node
// codex-aify hands its agent's model and effort to the APP-SERVER, as `-c` pairs (P0 C9; review of P6, R1).
//
// The app-server runs the agent; the TUI reads its configuration from the app-server and starts its
// thread with that model. Observed on codex-cli 0.159.3 through a logging proxy (aify-comms
// docs/superpowers/plans/evidence/2026-10-01-p6/codex-model-probe.mjs): `-c model=...` and
// `-c model_reasoning_effort=...` on the app-server decide the thread over CODEX_HOME's config.toml, and a
// `-m` given to the TUI still beats them. So the launcher puts them on the app-server only, and adds none
// when the operator's own arguments already give one. Executed to a stub codex that records both argvs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const definition = (over = {}) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "codex",
  mode: "resident", workspace: "C:/work", model: "gpt-5.5", effort: "xhigh", instructions: "", env: {}, herdrSpace: true, ...over } });

/** The value of each `-c key=value` pair in an argv, in order. */
const configPairs = (argv) => argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));

test("THE DEFINITION'S model and effort reach the app-server as -c pairs, and never the TUI", () => {
  const { run, appServerArgs, args, started } = launch("codex", ["--aify-agent", "lead"], { definitions: { lead: definition() } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(configPairs(appServerArgs), ['model="gpt-5.5"', 'model_reasoning_effort="xhigh"'], appServerArgs.join(" "));
  assert.ok(appServerArgs.indexOf("app-server") > appServerArgs.lastIndexOf("-c"), "a -c after the subcommand is the subcommand's argument");
  assert.deepEqual(configPairs(args), [], `the TUI got ${args.join(" ")}`);
  assert.equal(started.AIFY_AGENT_ROLE, "reviewer");
});

test("A MANAGED LAUNCH's model and effort reach the app-server; it reads no file", () => {
  const { run, appServerArgs } = launch("codex", ["--aify-agent", "lead"], {
    definitions: { lead: "{ not json" }, env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_MANAGED_MODEL: "gpt-m", AIFY_MANAGED_EFFORT: "low" } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(configPairs(appServerArgs), ['model="gpt-m"', 'model_reasoning_effort="low"']);
});

test("AIFY_MANAGED_* beats the definition on a launch that does read it", () => {
  const { run, appServerArgs } = launch("codex", ["--aify-agent", "lead"], {
    definitions: { lead: definition() }, env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_MODEL: "gpt-env", AIFY_MANAGED_EFFORT: "low" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(configPairs(appServerArgs), ['model="gpt-env"', 'model_reasoning_effort="low"']);
});

test("THE OPERATOR'S OWN -m or -c is theirs: nothing is added beside it", () => {
  for (const [given, expected] of [
    [["-m", "flag-model"], ['model_reasoning_effort="xhigh"']],
    [["--model=flag-model"], ['model_reasoning_effort="xhigh"']],
    [["-c", "model_reasoning_effort=low"], ['model="gpt-5.5"']],
    [["-c", "model=x", "--config", "model_reasoning_effort=low"], []],
  ]) {
    const { run, appServerArgs, args } = launch("codex", ["--aify-agent", "lead", ...given], { definitions: { lead: definition() } });
    assert.equal(run.status, 0, `${given.join(" ")}: ${run.stderr}`);
    assert.deepEqual(configPairs(appServerArgs), expected, given.join(" "));
    for (const token of given) assert.ok(args.includes(token), `${token} did not reach the TUI: ${args.join(" ")}`);
  }
});

test("CONTROL: no definition and no managed values add nothing, and a quote in a value stays inside its TOML string", () => {
  const plain = launch("codex", ["--aify-agent", "lead"]);
  assert.equal(plain.run.status, 0, plain.run.stderr);
  assert.deepEqual(configPairs(plain.appServerArgs), []);
  const quoted = launch("codex", ["--aify-agent", "lead"], { definitions: { lead: definition({ model: 'a"b\\c', effort: "" }) } });
  assert.equal(quoted.run.status, 0, quoted.run.stderr);
  assert.deepEqual(configPairs(quoted.appServerArgs), ['model="a\\"b\\\\c"']);
});

test("A CONTROL CHARACTER in a model or effort refuses the launch before anything starts (review of P6r, L2)", () => {
  // Written raw into `-c model="..."`, a newline made the app-server's configuration invalid TOML.
  for (const [label, opts] of [
    ["the definition's model", { definitions: { lead: definition({ model: "gpt\nx" }) } }],
    ["a managed effort", { env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_EFFORT: "high\tx" } }],
  ]) {
    const { run, appServerArgs, started } = launch("codex", ["--aify-agent", "lead"], opts);
    assert.equal(run.status, 78, `${label}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /holds a control character/, label);
    assert.deepEqual([appServerArgs, started], [[], {}], `${label}: nothing may start`);
  }
});

test("A NUL OR CR in the definition's selected value refuses too, though the shell never sees it (review of P6r2, L2)", () => {
  // bash drops a NUL and Git Bash a CR from what the reader prints, so the value arrived as "leftright".
  for (const [label, over] of [["model NUL", { model: "left\u0000right" }], ["model CR", { model: "left\rright" }],
    ["effort NUL", { effort: "left\u0000right" }], ["effort CR", { effort: "left\rright" }]]) {
    const { run, appServerArgs, started } = launch("codex", ["--aify-agent", "lead"], { definitions: { lead: definition(over) } });
    assert.equal(run.status, 78, `${label}: ${run.stdout}\n${run.stderr}`);
    assert.deepEqual([appServerArgs, started], [[], {}], `${label}: nothing may start`);
  }
  // An override wins over the definition, so its unusable value is not selected and nothing is refused.
  for (const [label, args, env, expected] of [
    ["-m", ["-m", "flag-model"], {}, ['model_reasoning_effort="xhigh"']],
    ["a managed model", [], { AIFY_AGENT_ID: "lead", AIFY_MANAGED_MODEL: "gpt-m" }, ['model="gpt-m"', 'model_reasoning_effort="xhigh"']],
  ]) {
    const { run, appServerArgs } = launch("codex", ["--aify-agent", "lead", ...args],
      { definitions: { lead: definition({ model: "left\rright" }) }, env });
    assert.equal(run.status, 0, `${label}: ${run.stderr}`);
    assert.deepEqual(configPairs(appServerArgs), expected, label);
  }
});
