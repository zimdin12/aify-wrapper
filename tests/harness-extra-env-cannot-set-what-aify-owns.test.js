// HARNESS_EXTRA_ENV cannot set an AIFY_ or HARNESS_ name, in any case (external review of 0.8.1, MEDIUM).
//
// Every launcher exports its lines verbatim AFTER the definition was read, and a definition's `env` or a spawn's
// variables can set HARNESS_EXTRA_ENV itself. So a line in it overwrote the model the definition selected, the
// mode, or the launcher's own controls: everything the AIFY_ prefix rule on a definition's env was meant to keep
// out.
//
// WHAT IS JUDGED, AND WHY NOT THE RUNTIME'S ENVIRONMENT. The stub records its environment one line per variable,
// and HARNESS_EXTRA_ENV is itself inherited with its newlines, so its second and later lines show up there as
// variables whether or not the launcher exported them. So the forced names are judged by what they would have
// changed (the model in the runtime's argv) and by the loop's own refusal; the ordinary name is put FIRST, where
// the recorder folds it into HARNESS_EXTRA_ENV's value, so a PROVIDER_TOKEN entry of its own is a real export.
import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const definition = (harness) => ({ version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness,
  mode: "resident", workspace: "C:/work", model: "m-defined", effort: "high", instructions: "", env: {}, herdrSpace: true } });
const argsFor = (client) => (client === "hermes" ? ["--aify-agent", "lead", "chat"] : ["--aify-agent", "lead"]);
const OWNED = ["AIFY_MANAGED_MODEL=m-forced", "AIFY_DEF_MODEL=m-forced", "aify_managed_model=m-forced", "HARNESS_ROLE=forced"];
const EXTRA = ["PROVIDER_TOKEN=kept", ...OWNED].join("\n");

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client}-aify: HARNESS_EXTRA_ENV sets an ordinary name and is refused every name aify owns`, () => {
    const { run, started, args, appServerArgs } = launch(client, argsFor(client), {
      definitions: { lead: definition(client) }, env: { HARNESS_EXTRA_ENV: EXTRA } });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(started.PROVIDER_TOKEN, "kept", "control: an ordinary name is still exported");
    const argv = JSON.stringify([...args, ...appServerArgs]);
    assert.ok(argv.includes("m-defined"), `the definition's model is the one that runs: ${argv}`);
    assert.equal(argv.includes("m-forced"), false, `a forced model reached the runtime: ${argv}`);
    for (const line of OWNED) {
      const name = line.slice(0, line.indexOf("="));
      assert.match(run.stderr, new RegExp(`HARNESS_EXTRA_ENV may not set ${name}, which aify owns; skipped`), name);
    }
  });
}
