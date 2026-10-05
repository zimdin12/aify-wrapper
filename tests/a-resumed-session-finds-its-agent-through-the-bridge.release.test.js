#!/usr/bin/env node
// `<runtime>-aify --resume <handle>` without an agent id asks the bridge which agent owns the handle,
// and the runtime starts as that agent -- in all three launchers.
//
// THE GAP (aify-comms v0.7.1 review, W1). hermes-aify's lookup had no behavioural test: claude's is
// run by aify-comms against a keyed service and codex's by a pin, and hermes' was correct by reading
// only. The three are run the same way here, so none of them is.
//
// AND WITH MSYS PATH REWRITING OFF (W04). `node "@@BRIDGE_DIR@@/agent-for-handle.mjs"` handed native
// Windows node the bridge directory as rendered, `/c/Users/...`. Node can open that only while Git
// Bash rewrites the argument on the way; with `MSYS_NO_PATHCONV=1` -- which hermes' own tool shell
// exports -- node looked for `C:\c\Users\...`, the lookup failed in silence, and the resumed session
// came up anonymous.
//
// The REAL rendered launchers run to a stub runtime (launch-to-a-stub-runtime.mjs), with the bridge
// directory rendered MSYS-style on Windows, as aify-comms' installer renders it, and a stub lookup that
// answers for one handle. Nothing contacts a service: the endpoint is 127.0.0.2:1.

import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWN, NOWHERE, UNKNOWN, launch } from "./launch-to-a-stub-runtime.mjs";

/** `<client>-aify --resume <handle> ...extraArgs`, with no agent id given. */
const resume = (client, handle, { extraArgs = [], ...options }) => launch(client, ["--resume", handle, ...extraArgs], options);

//: hermes is given a subcommand so it runs the stub directly instead of its gateway host; the lookup
//: happens before that choice either way.
const CASES = [
  ["claude", "claude-code-recovered", []],
  ["codex", "codex-recovered", []],
  ["hermes", "hermes-recovered", ["chat"]],
];

for (const [client, expected, extraArgs] of CASES) {
  test(`${client}-aify --resume finds its agent through the bridge`, () => {
    const { run, started, asked } = resume(client, KNOWN, { rewriting: true, extraArgs });
    assert.ok(Object.keys(started).length, `the runtime never started:\n${run.stdout}\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ID, expected,
      `the lookup did not reach the bridge (asked: ${JSON.stringify(asked)}):\n${run.stderr}`);
    assert.deepEqual(asked.map((a) => [a.endpoint.replace(/\/$/, ""), a.runtime, a.handle]),
      [[NOWHERE, expected.replace(/-recovered$/, ""), KNOWN]], "the lookup asked another endpoint, runtime or handle");
  });

  test(`${client}-aify --resume finds its agent with MSYS path rewriting off`, () => {
    const { run, started, asked } = resume(client, KNOWN, { rewriting: false, extraArgs });
    assert.ok(Object.keys(started).length, `the runtime never started:\n${run.stdout}\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ID, expected,
      `node could not open the bridge's helper (asked: ${JSON.stringify(asked)}):\n${run.stderr}`);
  });

  test(`CONTROL: ${client}-aify stays anonymous for a handle the service does not know`, () => {
    const { run, started, asked } = resume(client, UNKNOWN, { rewriting: true, extraArgs });
    assert.ok(Object.keys(started).length, `the runtime never started:\n${run.stdout}\n${run.stderr}`);
    assert.ok(asked.length > 0, `positive control: the lookup never ran:\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ID, undefined);
  });
}

// AN ID THE HANDLE NAMES GETS ITS DEFINITION (P0 C9; review of P6, R3). Each launcher used to read the
// definition for the id known from a flag or the environment, before recovery, so a resumed agent
// started with no defaults and an invalid file was never refused. Executed through the whole launch to
// the stub runtime: the role reaches the runtime's environment, and claude's model and effort its argv.
// The defaults are recomputed from what the flags and environment gave, so the role the first, id-less
// read defaulted to cannot pass for a given one.
const defined = (client, id, over = {}) => ({ version: 1, agent: { id, name: "Recovered", role: "reviewer",
  harness: client, mode: "resident", workspace: "C:/work", model: "opus", effort: "high", instructions: "",
  env: {}, herdrSpace: true, ...over } });

for (const [client, expected, extraArgs] of CASES) {
  test(`${client}-aify --resume applies the RECOVERED agent's definition`, () => {
    const { run, started, args } = resume(client, KNOWN, { rewriting: true, extraArgs,
      definitions: { [expected]: defined(client, expected) } });
    assert.equal(started.AIFY_AGENT_ID, expected, `${run.stdout}\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ROLE, "reviewer", `the recovered agent's definition was not applied:\n${run.stderr}`);
    if (client === "claude") {
      assert.deepEqual([args[args.indexOf("--model") + 1], args[args.indexOf("--effort") + 1]], ["opus", "high"], args.join(" "));
    }
  });

  test(`CONTROL: a role flag still beats the recovered ${client} agent's definition`, () => {
    const { run, started } = resume(client, KNOWN, { rewriting: true, extraArgs: ["--aify-role=flagged", ...extraArgs],
      definitions: { [expected]: defined(client, expected) } });
    assert.equal(started.AIFY_AGENT_ROLE, "flagged", `${run.stdout}\n${run.stderr}`);
  });

  test(`${client}-aify --resume REFUSES the recovered agent's invalid definition, and starts nothing`, () => {
    const { run, started } = resume(client, KNOWN, { rewriting: true, extraArgs, definitions: { [expected]: "{ not json" } });
    assert.equal(run.status, 78, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, new RegExp(`the definition of '${expected}' cannot be used`));
    assert.deepEqual(started, {}, "the runtime started");
  });

  test(`${client}-aify --resume REFUSES when it cannot run the reader for the recovered agent`, () => {
    const { run, started } = resume(client, KNOWN, { rewriting: true, extraArgs, reader: false });
    assert.equal(run.status, 78, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, new RegExp(`no definition reader at .*, so the definition of '${expected}' cannot be checked`));
    assert.deepEqual(started, {}, "the runtime started");
  });
}
