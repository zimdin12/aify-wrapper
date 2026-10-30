// What a fresh claude-aify or codex-aify launch hands its runtime, judged where the runtime sees it: the environment and
// argv a stub recorded. Each launch asserts every property its inputs decide, so the launches below are the input
// combinations that matter:
//
//   nothing set                 the baked endpoint, the runtime's name, no identity (claude says so), the bypass flag,
//                               managed without a TTY, the user's words last and whole, the runtime's exit as its own;
//   AIFY_* only, --safe --resident   identity and endpoint from the environment, the role defaulting to coder, no bypass
//                               flag, resident, and none of the launcher's own flags passed on;
//   HARNESS_* beside AIFY_*     HARNESS_* wins for identity, role and endpoint;
//   both, and the flags         --aify-agent and --aify-role win over both.
//
// claude's managed model goes to the agent it was written for when the launch names no model, and never over the
// caller's own --model; a launch with no id drops it (a-launcher-takes-defaults-from-its-definition). Then the contract's
// exits on a real launch, not --check: an emptied endpoint is 78 and a missing runtime 127, each with nothing started;
// and --check itself starts neither the runtime nor codex's app-server.

import assert from "node:assert/strict";
import { test } from "node:test";

import { launch, NOWHERE } from "./launch-to-a-stub-runtime.mjs";

const RUNTIME = { claude: "claude-code", codex: "codex" };
const BYPASS = { claude: "--dangerously-skip-permissions", codex: "--dangerously-bypass-approvals-and-sandbox" };
const CALLER = "http://127.0.0.2:2";
const HARNESS = "http://127.0.0.2:3";
/** An option the launcher does not consume, and a word with a space in it: both reach the runtime as given. */
const WORDS = ["--caller-flag", "two words"];
const BOTH = { HARNESS_ENDPOINT: HARNESS, HARNESS_IDENTITY: "harness-id", HARNESS_ROLE: "harness-role",
  AIFY_COMMS_URL: CALLER, AIFY_AGENT_ID: "env-id", AIFY_AGENT_ROLE: "env-role" };
/** The model claude is handed by `--model`, or undefined. */
const modelOf = (args) => (args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined);

// The managed model is the agent's own here (its id is the inherited AIFY_AGENT_ID), so only the caller's flag sets it aside.
test("claude-aify: a caller's --model wins over the managed one", () => {
  const { run, args } = launch("claude", ["--model", "m-caller"], { env: { AIFY_AGENT_ID: "env-id", AIFY_MANAGED_MODEL: "m-managed" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(args.filter((a) => a.startsWith("m-")), ["m-caller"], `${args}`);
  assert.equal(args.filter((a) => a === "--model").length, 1, `a second --model beside the caller's: ${args}`);
  assert.equal(modelOf(args), "m-caller", `${args}`);
});

for (const client of ["claude", "codex"]) {
  test(`${client}-aify with nothing set: the baked endpoint, no identity, the bypass flag, managed, the words last, the runtime's exit`, () => {
    const { run, started, args } = launch(client, WORDS, { env: { STUB_EXIT: "7" } });
    assert.equal(run.status, 7, `the runtime's exit is not the launcher's: ${run.stderr}`);
    assert.equal(started.AIFY_RUNTIME, RUNTIME[client]);
    assert.equal(started.AIFY_COMMS_URL, NOWHERE, "the baked endpoint, when the caller names none");
    assert.equal(started.AIFY_AGENT_ID, undefined);
    assert.equal(started.AIFY_AGENT_ROLE, undefined);
    assert.equal(started.AIFY_SESSION_MODE, "managed", "no TTY and no choice is managed");
    assert.ok(args.includes(BYPASS[client]), `no bypass flag by default: ${args}`);
    assert.deepEqual(args.slice(-WORDS.length), WORDS, `the user's words are not last and whole: ${args}`);
    assert.equal(args.includes("--check"), false, `a launch acquired --check: ${args}`);
    if (client === "claude") {
      assert.equal(started.AIFY_CHANNELS_ENABLED, "1");
      assert.match(run.stderr, /NO AGENT ID: .*Pass --aify-agent <id>/);
    } else {
      const remote = args.indexOf("--remote");
      assert.ok(remote >= 0, `no --remote: ${args}`);
      assert.match(started.AIFY_CODEX_APP_SERVER_URL ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(args[remote + 1], started.AIFY_CODEX_APP_SERVER_URL, `--remote is not the app-server's: ${args}`);
    }
  });

  test(`${client}-aify with AIFY_* only, --safe --resident: identity and endpoint from the environment, role coder, no bypass, resident`, () => {
    const { run, started, args } = launch(client, ["--safe", "--resident"],
      { env: { AIFY_AGENT_ID: "env-id", AIFY_COMMS_URL: CALLER, AIFY_MANAGED_MODEL: "m-managed" } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(started.AIFY_AGENT_ID, "env-id");
    assert.equal(started.AIFY_AGENT_ROLE, "coder", "the role defaults to coder");
    assert.equal(started.AIFY_COMMS_URL, CALLER, "the caller's endpoint wins over the baked one");
    assert.equal(started.AIFY_SESSION_MODE, "resident");
    assert.equal(args.includes(BYPASS[client]), false, `--safe kept the bypass flag: ${args}`);
    assert.deepEqual(args.filter((a) => a === "--safe" || a === "--resident"), [], `a launcher flag reached the runtime: ${args}`);
    if (client === "claude") assert.equal(modelOf(args), "m-managed", `the managed model, when the launch names none: ${args}`);
  });

  test(`${client}-aify with AIFY_AGENT_ROLE alone: that role reaches the runtime`, () => {
    const { run, started } = launch(client, [], { env: { AIFY_AGENT_ID: "env-id", AIFY_AGENT_ROLE: "env-role" } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(started.AIFY_AGENT_ROLE, "env-role");
  });

  test(`${client}-aify with HARNESS_* beside AIFY_*: HARNESS_* wins for identity, role and endpoint`, () => {
    const { run, started } = launch(client, [], { env: BOTH });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual([started.AIFY_AGENT_ID, started.AIFY_AGENT_ROLE, started.AIFY_COMMS_URL], ["harness-id", "harness-role", HARNESS]);
  });

  test(`${client}-aify: --aify-agent and --aify-role win over HARNESS_* and AIFY_*`, () => {
    const { run, started, args } = launch(client, ["--aify-agent", "flag-id", "--aify-role", "flag-role"], { env: BOTH });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual([started.AIFY_AGENT_ID, started.AIFY_AGENT_ROLE], ["flag-id", "flag-role"]);
    assert.deepEqual(args.filter((a) => a.startsWith("--aify-")), [], `a launcher flag reached the runtime: ${args}`);
  });

  test(`${client}-aify: an emptied endpoint is 78 on a real launch, with nothing started`, () => {
    const { run, started, appServerArgs } = launch(client, [], { env: { HARNESS_ENDPOINT: "" } });
    assert.equal(run.status, 78, run.stderr);
    assert.match(run.stderr, /HARNESS_ENDPOINT is empty/);
    assert.deepEqual([started, appServerArgs], [{}, []]);
  });

  test(`${client}-aify: a runtime missing from PATH is 127, named, with nothing started`, () => {
    const { run, started, appServerArgs } = launch(client, [], { runtime: false });
    assert.equal(run.status, 127, run.stderr);
    assert.match(run.stderr, new RegExp(`runtime CLI '${client}' was not found on PATH`));
    assert.deepEqual([started, appServerArgs], [{}, []]);
  });
}

test("codex-aify --check names the agent in each flag's spelling, says it adds no MCP command, and starts nothing", () => {
  for (const flag of [["--aify-agent", "spelled"], ["--agent-id", "spelled"], ["--aify-agent=spelled"]]) {
    const { run, started, appServerArgs } = launch("codex", ["--check", ...flag], { env: { HARNESS_MCP_COMMAND: "node x.mjs" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /identity\s*: spelled\n/, `${flag}: ${run.stdout}`);
    assert.match(run.stdout, /HARNESS_MCP_COMMAND not used by this wrapper/);
    assert.deepEqual([started, appServerArgs], [{}, []], `${flag}: --check started something`);
  }
});

test("claude-aify --check starts nothing", () => {
  const { run, started } = launch("claude", ["--check"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /nothing was started/i);
  assert.deepEqual(started, {});
});
