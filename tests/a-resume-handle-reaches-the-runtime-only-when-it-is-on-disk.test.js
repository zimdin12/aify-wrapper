// A resume handle reaches the runtime only when the runtime can resume it: claude keeps a session id that has a
// transcript under ~/.claude/projects and clears one that has none, and codex resumes a thread it finds under
// CODEX_HOME and starts fresh, saying so, when it finds none. And the agent lookup a bare handle triggers never stops
// a launch: a lookup that fails leaves the session anonymous, said out loud, and the runtime still starts.

import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWN, launch } from "./launch-to-a-stub-runtime.mjs";

/** A handle no transcript or rollout was written for. */
const STALE = "00000000-1111-2222-3333-444444444444";
/** A lookup that is asked, and then fails as an unreachable service does. */
const FAILING_LOOKUP = [
  'import fs from "node:fs";',
  "const [endpoint, runtime, handle] = process.argv.slice(2);",
  "fs.appendFileSync(process.env.STUB_LOOKUPS, JSON.stringify({ endpoint, runtime, handle }) + '\\n');",
  "process.exit(9);",
  "",
].join("\n");
const codexSession = { [`codex-home/sessions/${KNOWN}.jsonl`]: "{}\n" };
const codexHome = ({ dir }) => `${dir}/codex-home`;

test("claude-aify: a --resume id with a transcript is resumed, and one without is cleared, saying so", () => {
  const kept = launch("claude", ["--aify-agent", "a", "--resume", KNOWN]);
  assert.equal(kept.run.status, 0, kept.run.stderr);
  assert.deepEqual(kept.args.slice(kept.args.indexOf("--resume"), kept.args.indexOf("--resume") + 2), ["--resume", KNOWN], `${kept.args}`);
  assert.equal(kept.started.CLAUDE_SESSION_ID, KNOWN);
  const stale = launch("claude", ["--aify-agent", "a", "--resume", STALE]);
  assert.equal(stale.run.status, 0, stale.run.stderr);
  assert.match(stale.run.stderr, new RegExp(`'${STALE}' has no transcript`));
  assert.deepEqual(stale.args.filter((a) => a === "--resume" || a === STALE), [], `${stale.args}`);
  assert.equal(stale.started.CLAUDE_SESSION_ID, undefined);
});

test("claude-aify: an inherited CLAUDE_SESSION_ID with a transcript is handed on, and one without is cleared", () => {
  const kept = launch("claude", ["--aify-agent", "a"], { env: { CLAUDE_SESSION_ID: KNOWN } });
  assert.equal(kept.run.status, 0, kept.run.stderr);
  assert.equal(kept.started.CLAUDE_SESSION_ID, KNOWN);
  assert.doesNotMatch(kept.run.stderr, /has no transcript/);
  const { run, started, args } = launch("claude", ["--aify-agent", "a"], { env: { CLAUDE_SESSION_ID: STALE } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, new RegExp(`'${STALE}' has no transcript`));
  assert.equal(started.CLAUDE_SESSION_ID, undefined);
  assert.equal(args.includes(STALE), false);
});

// The missing case is a CODEX_HOME with no sessions folder yet, as on a host where codex never saved one: the lookup
// there failed, and under pipefail the launch ended with exit 1 and nothing said.
test("codex-aify: a --resume thread under CODEX_HOME is resumed, and one not there starts fresh, saying so", () => {
  const found = launch("codex", ["--aify-agent", "a", "--resume", KNOWN], { files: codexSession, env: { CODEX_HOME: codexHome } });
  assert.equal(found.run.status, 0, found.run.stderr);
  assert.deepEqual(found.args.slice(-3), ["resume", "--include-non-interactive", KNOWN], `${found.args}`);
  const missing = launch("codex", ["--aify-agent", "a", "--resume", KNOWN], { env: { CODEX_HOME: codexHome } });
  assert.equal(missing.run.status, 0, missing.run.stderr);
  assert.match(missing.run.stderr, new RegExp(`saved session ${KNOWN} not found in codex storage; starting fresh`));
  assert.equal(missing.args.includes("resume"), false, `${missing.args}`);
});

for (const [client, runtime, options] of [
  ["claude", "claude-code", {}],
  ["codex", "codex", { files: codexSession, env: { CODEX_HOME: codexHome } }],
]) {
  test(`${client}-aify: a bare --resume whose agent lookup fails still launches, anonymous and saying so`, () => {
    const { run, started, asked } = launch(client, ["--resume", KNOWN], { ...options, bridgeFiles: { "agent-for-handle.mjs": FAILING_LOOKUP } });
    assert.deepEqual(asked.map((a) => [a.runtime, a.handle]), [[runtime, KNOWN]], "control: the lookup was never asked");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(started.AIFY_RUNTIME, runtime, "the runtime did not start");
    assert.equal(started.AIFY_AGENT_ID, undefined);
    assert.match(run.stderr, /NO AGENT ID/);
  });
}
