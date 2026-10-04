// claude-aify and hermes-aify refuse a control character in the model or effort they select, as codex-aify does.
//
// The reader names a definition field holding one in AIFY_DEF_CONTROL, because the value itself reaches the
// shell with a NUL or CR already gone ("left\rright" arrives as "leftright"). codex-aify checked it; claude
// and hermes initialised the variable and never read it, so they started on the altered value (aify-comms'
// 0.8 whole-range review, R4). Only a value the launch selects counts: an override that wins is not refused.
import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const definition = (harness, over = {}) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness,
  mode: "resident", workspace: "C:/work", model: "m-1", effort: "high", instructions: "", env: {}, herdrSpace: true, ...over } });
const argsFor = (client, extra = []) => (client === "hermes" ? ["--aify-agent", "lead", ...extra, "chat"] : ["--aify-agent", "lead", ...extra]);

for (const client of ["claude", "hermes"]) {
  test(`${client}-aify: a NUL or CR in the definition's selected model or effort refuses, and nothing starts`, () => {
    for (const [label, over] of [["model CR", { model: "left\rright" }], ["model NUL", { model: "left\u0000right" }],
      ["effort CR", { effort: "left\rright" }]]) {
      const { run, started } = launch(client, argsFor(client), { definitions: { lead: definition(client, over) } });
      assert.equal(run.status, 78, `${label}: ${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /holds a control character/, label);
      assert.deepEqual(started, {}, `${label}: the runtime started`);
    }
  });

  test(`${client}-aify CONTROL: a clean definition starts, and an override that wins is not refused`, () => {
    assert.equal(launch(client, argsFor(client), { definitions: { lead: definition(client) } }).run.status, 0);
    const managed = launch(client, argsFor(client), { definitions: { lead: definition(client, { model: "left\rright" }) },
      env: { AIFY_AGENT_ID: "lead", AIFY_MANAGED_MODEL: "m-managed" } });
    assert.equal(managed.run.status, 0, `a managed model wins over the definition's: ${managed.run.stderr}`);
  });
}
