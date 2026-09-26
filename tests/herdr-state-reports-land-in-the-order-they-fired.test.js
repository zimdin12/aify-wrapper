#!/usr/bin/env node
// The agent's state hooks run in the background, so several reports can be in flight at once: an `idle`
// that lands before its turn's last `working` would leave the pane reading working. bin/aify-herdr-state.sh
// carries when each hook fired and serializes read-report-record per pane. These run the real script
// through `sh` against a stub `herdr` that records what it was asked, which also runs on Windows (the
// shell runs the stub).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_SCRIPT = path.join(ROOT, "bin", "aify-herdr-state.sh").replace(/\\/g, "/");

/** A pane with a stub herdr. With `holdFirst`, the first report waits in Herdr until `release()`. */
function pane({ holdFirst = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-order-")).replace(/\\/g, "/");
  const log = `${dir}/reports.log`;
  const herdr = `${dir}/herdr`;
  const cache = `${dir}/aify-herdr-w1-p2.state`;
  const hold = holdFirst
    ? `if mkdir '${dir}/first' 2>/dev/null; then touch '${dir}/held'; while [ ! -e '${dir}/gate' ]; do sleep 0.05; done; fi\n`
    : "";
  fs.writeFileSync(herdr, `#!/bin/sh\n${hold}printf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: dir, HERDR_BIN_PATH: herdr,
    AIFY_HERDR_AGENT: "claude-aify", AIFY_HERDR_PANE_ID: "w1:p2", AIFY_HERDR_LAUNCH: "42",
  };
  const report = (state, firedAt) => {
    const hookEnv = firedAt === undefined ? env : { ...env, AIFY_HOOK_FIRED_AT: firedAt };
    const result = spawnSync("sh", [STATE_SCRIPT, state], { input: "", encoding: "utf8", env: hookEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  };
  /** Start a report without waiting for it; resolves with its exit status. */
  const start = (state, firedAt) => new Promise((resolve) => {
    const child = spawn("sh", [STATE_SCRIPT, state], { stdio: "ignore", env: { ...env, AIFY_HOOK_FIRED_AT: firedAt } });
    child.on("exit", resolve);
  });
  const until = async (file) => { while (!fs.existsSync(`${dir}/${file}`)) await new Promise((r) => setTimeout(r, 20)); };
  const release = () => fs.writeFileSync(`${dir}/gate`, "");
  const states = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((line) => line.split(" --state ")[1]);
  return { report, start, until, release, states, cache, lock: `${cache}.lock` };
}

/** The msys/posix pid of a process that has exited. */
const deadPid = () => spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();

test("a report older than the last one is dropped", () => {
  const { report, states } = pane();
  report("idle", "1790000000.000002");
  report("working", "1790000000.000001");
  assert.deepEqual(states(), ["idle"]);
});

test("CONTROL: reports in the order they fired all land", () => {
  const { report, states, cache } = pane();
  report("working", "1790000000.000001");
  report("idle", "1790000000.000002");
  assert.deepEqual(states(), ["working", "idle"]);
  assert.equal(fs.readFileSync(cache, "utf8"), "42 idle 1790000000000002");
});

test("a locale comma and a short fraction read as the same microseconds", () => {
  const { report, states, cache } = pane();
  report("idle", "1790000000,5");
  assert.equal(fs.readFileSync(cache, "utf8"), "42 idle 1790000000500000");
  report("working", "1790000000.400000");
  assert.deepEqual(states(), ["idle"]);
});

test("with no time passed in, the shell's own clock stamps the report to the microsecond", () => {
  // bash has EPOCHREALTIME; dash (Linux `sh`) falls back to GNU `date +%s%N`.
  const { report, states, cache } = pane();
  const before = Date.now() * 1000;
  report("working");
  const [, , fired] = fs.readFileSync(cache, "utf8").split(" ");
  assert.match(fired, /^[0-9]{16}$/);
  assert.ok(Math.abs(Number(fired) - before) < 60_000_000, `${fired} is not this host's clock in microseconds`);
  report("idle");
  assert.deepEqual(states(), ["working", "idle"]);
});

test("an unchanged state still advances the record, so an older different state cannot follow it", () => {
  const { report, states, cache } = pane();
  report("working", "1790000000.000001");
  report("working", "1790000000.000003");
  assert.equal(fs.readFileSync(cache, "utf8"), "42 working 1790000000000003");
  report("idle", "1790000000.000002");
  assert.deepEqual(states(), ["working"]);
});

// Review of 03bdce4: a working report in flight, a later idle and a newest working all racing ended with
// the pane idle and the record saying working.
for (const [name, order] of [["idle queues first", ["idle", "working"]], ["the newest working queues first", ["working", "idle"]]]) {
  test(`three hooks in flight at once leave the newest state on the pane (${name})`, async () => {
    const { start, until, release, states, cache } = pane({ holdFirst: true });
    const fired = { idle: "1790000000.000002", working: "1790000000.000003" };
    const first = start("working", "1790000000.000001");
    const queued = [];
    try {
      await until("held");
      for (const state of order) {
        queued.push(start(state, fired[state]));
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      release();  // a failure above must not leave the held stub waiting for ever
    }
    assert.deepEqual(await Promise.all([first, ...queued]), [0, 0, 0]);
    assert.equal(states().at(-1), "working", `the pane ends on an older state: ${states()}`);
    assert.equal(fs.readFileSync(cache, "utf8"), "42 working 1790000000000003");
  });
}

test("a lock left by a holder that died is broken", () => {
  const { report, states, lock } = pane();
  fs.mkdirSync(lock);
  fs.writeFileSync(`${lock}/owner`, deadPid());
  report("working", "1790000000.000001");
  assert.deepEqual(states(), ["working"]);
  assert.equal(fs.existsSync(lock), false, "the report left its lock behind");
});

test("a lock whose holder never recorded itself is broken after a wait", () => {
  const { report, states, lock } = pane();
  fs.mkdirSync(lock);
  report("working", "1790000000.000001");
  assert.deepEqual(states(), ["working"]);
});

test("CONTROL: a lock held by a live report is waited for, not broken", async () => {
  const { start, until, release, states, cache } = pane({ holdFirst: true });
  const first = start("working", "1790000000.000001");
  let second;
  try {
    await until("held");
    second = start("idle", "1790000000.000002");
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(states(), [], "the waiting report went around a live holder");
  } finally {
    release();  // a failure above must not leave the held stub waiting for ever
  }
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.deepEqual(states(), ["working", "idle"]);
  assert.equal(fs.readFileSync(cache, "utf8"), "42 idle 1790000000000002");
});
