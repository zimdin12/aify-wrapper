// hermes-aify points its delivery loop at the service it was launched for, whatever the environment held.
//
// The launcher exported CLAUDE_MCP_SERVER_URL="${CLAUDE_MCP_SERVER_URL:-$AIFY_SERVER_URL}", keeping an inherited
// value, and the bridge's delivery loop reads CLAUDE_MCP_SERVER_URL before AIFY_SERVER_URL (aify-comms
// aify-http.mjs). A spawn or definition variable named CLAUDE_MCP_SERVER_URL, which neither the AIFY_ nor the
// HARNESS_ reservation covers, therefore aimed a worker's deliveries at another service (aify-comms' triage of
// the external review of 0.8.4). The launcher now sets it from AIFY_SERVER_URL, its one configured endpoint.
import assert from "node:assert/strict";
import { test } from "node:test";

import { launch, NOWHERE } from "./launch-to-a-stub-runtime.mjs";

const definition = { version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "hermes",
  mode: "resident", workspace: "C:/work", model: "m-1", effort: "high", instructions: "", env: {}, herdrSpace: true } };
const args = ["--aify-agent", "lead", "chat"];

test("an inherited CLAUDE_MCP_SERVER_URL does not reach the runtime: it is the launcher's endpoint", () => {
  const { run, started } = launch("hermes", args, { definitions: { lead: definition },
    env: { CLAUDE_MCP_SERVER_URL: "http://127.0.0.3:9" } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(started.AIFY_SERVER_URL, NOWHERE, "control: the launcher's endpoint is the one it was rendered with");
  assert.equal(started.CLAUDE_MCP_SERVER_URL, NOWHERE);
});

test("CONTROL: with nothing inherited it is the launcher's endpoint too", () => {
  const { run, started } = launch("hermes", args, { definitions: { lead: definition } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(started.CLAUDE_MCP_SERVER_URL, NOWHERE);
});
