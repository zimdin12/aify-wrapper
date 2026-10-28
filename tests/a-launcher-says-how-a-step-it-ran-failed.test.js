// A launcher step that runs a helper and stops the launch on its failure says the helper's exit status.
//
// WHY: comms' full run saw "this session's MCP entries could not be written; re-run the installer" with no line from
// the writer at all -- node had exited non-zero without a word, most likely killed under load -- and the advice sent
// the operator to an install that was fine. Each helper here is replaced by one that exits 3 and prints nothing, which
// is exactly the case a generic line cannot tell apart from a refusal.

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const SILENT = "process.exit(3);\n";
const lead = { version: 1, agent: { id: "lead", name: "Lead", role: "reviewer", harness: "claude", mode: "resident", workspace: "C:/work",
  model: "opus", effort: "high", instructions: "", env: {}, herdrSpace: true } };

test("the definition reader, on a named launch and on a managed launch's instructions", () => {
  const files = { "wrapper/bin/aify-definition.mjs": SILENT };
  const named = launch("claude", ["--aify-agent", "lead"], { definitions: { lead }, files });
  assert.equal(named.run.status, 78, named.run.stderr);
  assert.match(named.run.stderr, /the definition of 'lead' cannot be used \(the reader exited 3, above\)/);
  const managed = launch("claude", ["--aify-agent", "lead"], { definitions: { lead }, files,
    env: { AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" } });
  assert.equal(managed.run.status, 78, managed.run.stderr);
  assert.match(managed.run.stderr, /the instructions of 'lead' cannot be handed to the runtime \(the reader exited 3, above\)/);
});

test("claude's per-session MCP writer", () => {
  const registry = { version: 1, services: { svc: { endpoint: "http://127.0.0.2:1", sessionInject: { mcp: true },
    mcp: [{ name: "svc", command: "node", args: ["svc.js"] }] } } };
  const r = launch("claude", ["--aify-agent", "lead"], { definitions: { lead }, registry, files: { "wrapper/bin/aify-session-mcp.mjs": SILENT } });
  assert.equal(r.run.status, 78, r.run.stderr);
  assert.match(r.run.stderr, /this session's MCP entries could not be written \(aify-session-mcp exited 3;/);
  assert.doesNotMatch(r.run.stderr, /re-run the installer/, "the advice sent the operator to an install that was fine");
});

test("the resident lifetime writer", () => {
  const r = launch("claude", ["--aify-agent", "lead", "--resident"], { definitions: { lead }, lifetimes: true,
    files: { "wrapper/bin/aify-resident-record.mjs": SILENT } });
  assert.equal(r.run.status, 78, r.run.stderr);
  assert.match(r.run.stderr, /cannot write the resident lifetime \(aify-resident-record exited 3\)/);
});

test("hermes' gateway host", () => {
  const hermesLead = { ...lead, agent: { ...lead.agent, harness: "hermes" } };
  const r = launch("hermes", ["--aify-agent", "lead"], { definitions: { lead: hermesLead }, files: { "wrapper/bin/aify-hermes-gateway.mjs": SILENT } });
  assert.notEqual(r.run.status, 0, r.run.stderr);
  assert.match(r.run.stderr, /managed gateway host for 'lead' did not come up \(aify-hermes-gateway exited 3\)/);
});
