#!/usr/bin/env node
// A pane this launcher claimed must not hand itself back to Herdr's own resume.
//
// THE DEFECT, MEASURED ON A REAL HOST 2026-09-16 (Herdr 0.9.0, Linux). The claim reports the agent
// under `herdr:aify`, a source Herdr's allowlist does not contain, so Herdr persists no resumable
// session for the pane -- that is the whole mechanism the restore depends on. But Herdr also installs
// an integration INTO THE AGENT'S OWN CONFIG (`~/.claude/hooks/herdr-agent-state.sh`,
// `HERDR_INTEGRATION_ID=claude`), and that hook runs inside the agent THIS launcher starts. On
// SessionStart it sends `pane.report_agent_session` under `herdr:claude` carrying the agent's session
// id, which overwrites the claim's report. Herdr then had a resumable session after all: after a
// restart it typed a BARE `claude --resume <id>` into all three claimed panes, and the agents came
// back with no wrapper, no lease and no bridge. The aify restore could not save them either -- it
// refuses any pane Herdr reports an agent on, which by then it did.
//
// THAT HOOK GATES ON `HERDR_PANE_ID`. Driven directly, with the variable it reports and without it:
//
//   HERDR_PANE_ID set    -> exit 0, one pane.report_agent_session, source herdr:claude
//   HERDR_PANE_ID unset  -> exit 0, nothing sent
//
// So the launcher takes that one variable out of a CLAIMED agent's environment and keeps its own copy
// for aify's own reports. These tests assert both halves against the rendered launcher: what the
// agent's environment actually contains, and that aify's state reports still arrive. The pane this
// launcher did NOT claim is the control, and it must keep everything it had.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32" && "the stub herdr is a shell script, which Windows cannot spawn by path";

/**
 * Render the launcher, run it with a stub agent that writes down ITS OWN ENVIRONMENT, and hand back
 * both that environment and a way to fire the hooks with it.
 *
 * THE AGENT'S ENVIRONMENT IS THE EVIDENCE, not the launcher's. A hook the agent runs inherits what
 * the agent has, so a test that reconstructs the environment from what it passed IN would pass
 * whether or not the launcher changed anything -- which is the one thing being measured here.
 */
function launch({ env = {}, listFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-resume-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  for (const d of [out, stubs, home, path.join(bridge, "node_modules")]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(ROOT, path.join(bridge, "node_modules", "aify-wrapper"), "dir");

  const rendered = spawnSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE,
    "--render-only", out, "--bridge-dir", bridge], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  const settings = path.join(dir, "settings.json");
  const agentEnv = path.join(dir, "agent-env");
  fs.writeFileSync(path.join(stubs, "claude"), [
    "#!/bin/sh",
    `env > '${agentEnv}'`,
    'while [ $# -gt 0 ]; do',
    `  if [ "$1" = "--settings" ]; then cp "$2" '${settings}'; fi`,
    "  shift",
    "done",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });

  const calls = path.join(dir, "herdr-calls");
  const herdr = path.join(stubs, "herdr");
  fs.writeFileSync(herdr, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${calls}'`,
    'if [ "$1 $2" = "pane list" ]; then',
    listFails ? "  exit 1" : `  printf '%s' '{"result":{"panes":[{"pane_id":"w1:p2","terminal_id":"term-1"}]}}'`,
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });

  const baseEnv = {
    PATH: [stubs, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    HARNESS_IDENTITY: "probe-agent",
    HERDR_BIN_PATH: herdr,
    TMPDIR: dir,
  };
  const run = spawnSync("bash", [path.join(out, "claude-aify")], {
    encoding: "utf8", env: { ...baseEnv, ...env }, timeout: 60_000,
  });
  assert.equal(run.status, 0, `launcher failed: ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(agentEnv), `the stub agent never ran:\n${run.stderr}`);

  // `env` output, back into a map. A variable the launcher unset is simply absent.
  const seen = new Map();
  for (const line of fs.readFileSync(agentEnv, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) seen.set(line.slice(0, at), line.slice(at + 1));
  }

  const fire = (event) => {
    const config = JSON.parse(fs.readFileSync(settings, "utf8"));
    for (const group of config.hooks[event] || []) {
      for (const hook of group.hooks) {
        if (!hook.command.includes("aify-herdr-state.sh")) continue;
        const result = spawnSync("sh", ["-c", hook.command], {
          input: "{}", encoding: "utf8", env: Object.fromEntries(seen),
        });
        assert.equal(result.status, 0, `${event} hook failed: ${result.stderr}`);
      }
    }
  };
  const reports = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "")
    .split("\n").filter(line => line.startsWith("pane report-agent"));
  return { seen, fire, reports };
}

const IN_A_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" };

test("A CLAIMED PANE: the agent gets no HERDR_PANE_ID, so Herdr's own integration cannot speak for it",
  { skip: WIN }, () => {
    const { seen } = launch({ env: IN_A_PANE });
    assert.equal(seen.has("HERDR_PANE_ID"), false,
      "the agent still carries HERDR_PANE_ID, so Herdr's integration will report the pane under its own source and resume a bare agent next start");
    assert.equal(seen.get("AIFY_HERDR_PANE_ID"), "w1:p2",
      "the launcher did not keep its own copy of the pane id, so aify's own state reports have nothing to report to");
  });

test("A CLAIMED PANE STILL REPORTS ITS STATE, through the private copy", { skip: WIN }, () => {
  const { fire, reports } = launch({ env: IN_A_PANE });
  // The launch itself reports twice — the claim's `idle`, and the `idle` the exit trap sends once the
  // stub agent returns — so the new report is the one this measures.
  const before = reports().length;
  fire("UserPromptSubmit");
  const sent = reports();
  assert.equal(sent.length, before + 1, `expected one new report, got ${JSON.stringify(sent.slice(before))}`);
  assert.match(sent[before], /^pane report-agent w1:p2 --source herdr:aify --agent claude-aify --state working$/,
    "the state report did not reach the right pane under the claim's own source");
  for (const line of sent) {
    assert.match(line, /^pane report-agent w1:p2 --source herdr:aify /,
      `a report went somewhere else, or under another source: ${line}`);
  }
});

test("CONTROL — A PANE THIS LAUNCHER DID NOT CLAIM KEEPS EVERYTHING IT HAD", { skip: WIN }, () => {
  // `pane list` fails, so the claim refuses: no label, no record, and Herdr's own integration is the
  // only thing that will ever report this pane. Taking its variable away here would break the resume
  // of a pane aify never owned, which is the regression this control exists to catch.
  const { seen } = launch({ env: IN_A_PANE, listFails: true });
  assert.equal(seen.get("HERDR_PANE_ID"), "w1:p2",
    "an unclaimed pane lost HERDR_PANE_ID, so Herdr's native resume was broken for a pane aify does not own");
  assert.equal(seen.has("AIFY_HERDR_PANE_ID"), false,
    "an unclaimed pane was given the private copy, which claims an ownership the launcher does not have");
});
