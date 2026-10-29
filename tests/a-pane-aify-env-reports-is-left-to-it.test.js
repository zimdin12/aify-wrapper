// HERDR STATUS SYNC, PHASE 1: a managed worker's pane that aify-env's pane reporter speaks for is left to it.
//
// aify-env (0.9.10 on) sets AIFY_HERDR_PANE_REPORTER=herdr:aify beside AIFY_HERDR_PANE_FILE exactly where its reporter
// tells that pane its word for the agent. There the launcher gives the agent no Herdr state hooks and makes no exit
// report, so the pane has one writer. The pane file alone is every aify-env before the reporter, and keeps both.
// bin/aify-herdr-launch.sh `aify_herdr_hooks_report` decides; this runs each rendered launcher to a stub runtime with a
// stub herdr that records what it is asked, so what is checked is what the launcher does, not what the helper says.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { launch } from "./launch-to-a-stub-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = (p) => p.split(path.sep).join("/");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pane file naming a pane, and a herdr that appends each call to a log; the env that points a launcher at both. */
function aPane() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-reporter-pane-"));
  const calls = path.join(dir, "herdr-calls");
  const herdr = path.join(dir, "herdr");
  fs.writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${posix(calls)}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "pane"), "w2:p5\n");
  const reports = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").split("\n").filter((line) => line.startsWith("pane report-agent"));
  return { dir, reports, env: { AIFY_HERDR_PANE_FILE: posix(path.join(dir, "pane")), HERDR_BIN_PATH: posix(herdr) } };
}

// What the exit report and codex's hook builder run, put in the run's wrapper directory beside what the shared stub
// install copies, which leaves them out so no launch it makes can reach a real herdr. Here HERDR_BIN_PATH is the stub.
const EXIT_REPORT = Object.fromEntries([
  "bin/aify-runtime-exited.sh", "bin/aify-herdr-state.sh",
  "bin/aify-herdr-pane.mjs", "lib/codex-herdr-hooks.mjs", "lib/herdr-binary.mjs", "lib/herdr-cli.mjs", "lib/herdr-pane.mjs",
  "lib/herdr-replay.mjs", "lib/herdr-restore.mjs",
].map((file) => [`wrapper/${file}`, fs.readFileSync(path.join(ROOT, file), "utf8")]));

/** What the runtime was started with that turns its Herdr hooks on, by client. */
function hooksGiven(client, result) {
  if (client === "codex") return result.appServerArgs.some((arg) => arg.includes("aify-herdr-state"));
  if (client === "hermes") return Boolean(result.started.AIFY_HERDR_HERMES_PLUGIN);
  return Boolean(result.started.AIFY_HERDR_AGENT);
}

// A plain hermes launch makes no exit report at all: only its agent-id branch does, checked on its own below.
for (const client of ["claude", "codex", "hermes"]) {
  const exits = client !== "hermes";
  test(`${client}: a pane aify-env's reporter speaks for gets no state hooks${exits ? " and no exit report" : ""}; a pane file alone keeps them`, async () => {
    // CONTROL FIRST, in the same run: the pane file alone (aify-env before the reporter) is reported to, the exit
    // report included, so the stub herdr and the wait below can see a report when one is made.
    const before = aPane();
    try {
      const kept = launch(client, [], { env: before.env, files: EXIT_REPORT });
      assert.equal(kept.run.status, 0, `${kept.run.stdout}\n${kept.run.stderr}`);
      // `${0##*/}`: the stub starts the launcher by a Windows path there, which has no `/` to cut at.
      assert.match(kept.started.AIFY_HERDR_AGENT ?? "", new RegExp(`(^|[\\\\/])${client}-aify$`));
      assert.ok(hooksGiven(client, kept), "control: the pane file alone gave the runtime no Herdr hooks");
      const started = Date.now();
      while (exits && !before.reports().some((line) => line.includes("--state idle")) && Date.now() - started < 15_000) await pause(50);
      const latency = Date.now() - started;
      if (exits) assert.ok(before.reports().some((line) => line.startsWith("pane report-agent w2:p5 --source herdr:aify") && line.includes("--state idle")),
        `control: no exit report reached the pane: ${before.reports().join(" | ")}`);

      const held = aPane();
      try {
        // With an agent name inherited, as a launch nested in a managed agent's pane has its parent's.
        const inherited = { AIFY_HERDR_PANE_REPORTER: "herdr:aify", AIFY_HERDR_AGENT: "parent-aify" };
        const left = launch(client, [], { env: { ...held.env, ...inherited }, files: EXIT_REPORT });
        assert.equal(left.run.status, 0, `${left.run.stdout}\n${left.run.stderr}`);
        assert.equal(left.started.AIFY_HERDR_AGENT, undefined, "the agent was left a name to report under to a pane aify-env speaks for");
        assert.equal(hooksGiven(client, left), false, "the runtime was given Herdr hooks for a pane aify-env speaks for");
        // Three times as long as the control's exit report took, and at least a second.
        await pause(Math.max(1_000, 3 * latency));
        assert.deepEqual(held.reports(), [], "the launcher reported to a pane aify-env speaks for");
      } finally {
        fs.rmSync(held.dir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(before.dir, { recursive: true, force: true });
    }
  });
}

// EACH EXIT SITE ON ITS OWN. The launch above clears an inherited agent name, so the state script stays silent even if
// an exit site still hands it `herdr`: the two guards would hide each other. Here each launcher's exit function, cut
// from its template, runs in bash with the helper sourced, a parent's agent name inherited, and what it calls stubbed.
// It sends the exit script's output to /dev/null, so the stub writes the Herdr argument it was handed, the launcher's
// whole say in the exit report, to a file. This also reaches hermes' report, made only on its agent-id branch.
const EXIT_FUNCTIONS = {
  claude: ["_aify_runtime_exited() {", "\n}\n"],
  codex: ["_aify_runtime_exited() {", "\n}\n"],
  hermes: ["  _aify_hermes_on_exit() {", "\n  }\n"],
};
for (const [client, [opening, closing]] of Object.entries(EXIT_FUNCTIONS)) {
  test(`${client}: its exit report goes to a pane file alone, and not to one aify-env's reporter speaks for`, () => {
    const source = fs.readFileSync(path.join(ROOT, "wrappers", `${client}-aify.sh.in`), "utf8");
    const start = source.indexOf(opening);
    const end = source.indexOf(closing, start);
    assert.ok(start > 0 && end > start, "the exit function moved; this test reads it from the template");
    const probe = [
      `. "${posix(path.join(ROOT, "bin", "aify-herdr-launch.sh"))}"`,
      "kill() { :; }; aify_lease_release() { :; }; aify_lifetime_release() { :; }; HERMES_LOOP_PID=999999",
      'sh() { case "$1" in */aify-runtime-exited.sh) printf "herdr=[%s]" "${3-}" > "$PROBE_OUT";; *) return 99;; esac; }',
      source.slice(start, end + closing.length).replaceAll("@@WRAPPER_DIR@@", "/w").replaceAll("@@BRIDGE_DIR@@", "/b"),
      `AIFY_RUNTIME_RUNNING=1; ${opening.trim().replace("() {", "")}`,
    ].join("\n");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-exit-site-"));
    const handed = (name, env) => {
      const out = path.join(dir, name);
      const run = spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail\n${probe}`], { encoding: "utf8",
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? "", PROBE_OUT: posix(out), AIFY_HERDR_AGENT: "parent-aify", ...env } });
      assert.equal(run.status, 0, run.stderr);
      return fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "<not called>";
    };
    try {
      assert.equal(handed("alone", { AIFY_HERDR_PANE_FILE: "/state/pane" }), "herdr=[herdr]", "control: a pane file alone was not reported to on exit");
      assert.equal(handed("held", { AIFY_HERDR_PANE_FILE: "/state/pane", AIFY_HERDR_PANE_REPORTER: "herdr:aify" }), "herdr=[]",
        "the exit was reported to a pane aify-env speaks for");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// THE CONTRACT WITH aify-env, read from its checkout: AIFY_ENV_REPO, else beside this one, else ~/projects/aify-env.
// A checkout from before the variable (0.9.9 and older) SKIPS BY NAME, so a proof that read nothing is not a pass.
const ENV_CANDIDATES = [process.env.AIFY_ENV_REPO, path.join(ROOT, "..", "aify-env"), path.join(os.homedir(), "projects", "aify-env")].filter(Boolean);
const OPENER = "lib/herdr-pane-opener.mjs", REPORTER = "lib/herdr-pane-reporter.mjs";
const ENV_REPO = ENV_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, OPENER))
  && fs.readFileSync(path.join(dir, OPENER), "utf8").includes("AIFY_HERDR_PANE_REPORTER"));

test("aify-env sets AIFY_HERDR_PANE_REPORTER to its reporter's source, the value the launchers stand down for", {
  skip: ENV_REPO ? false : `no aify-env checkout whose ${OPENER} sets AIFY_HERDR_PANE_REPORTER (looked in ${ENV_CANDIDATES.join(", ")}): NOT verified`,
}, () => {
  const opener = fs.readFileSync(path.join(ENV_REPO, OPENER), "utf8");
  const reporter = fs.readFileSync(path.join(ENV_REPO, REPORTER), "utf8");
  assert.match(opener, /AIFY_HERDR_PANE_REPORTER = HERDR_AGENT_SOURCE\b/, "aify-env sets the variable to something other than its reporter's source");
  const source = /export const HERDR_AGENT_SOURCE = "([^"]*)"/.exec(reporter)?.[1];
  const helper = fs.readFileSync(path.join(ROOT, "bin", "aify-herdr-launch.sh"), "utf8");
  assert.ok(source && helper.includes(`[ "\${AIFY_HERDR_PANE_REPORTER:-}" = "${source}" ]`),
    `aify-env's reporter source ${source} is not the value bin/aify-herdr-launch.sh stands down for`);
});
