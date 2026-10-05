#!/usr/bin/env node
// The agent's state hooks run in the background, so several reports can be in flight at once: an `idle`
// that lands before its turn's last `working` would leave the pane reading working. Herdr puts them in
// order itself: it keeps the report with the highest --seq and drops an older one (0.9.1, measured
// against a live pane 2026-09-28). So bin/aify-herdr-state.sh's whole job is to send each report with
// the time its hook fired, and to send it at once. These run the real script through `sh` against a stub
// `herdr` that records what it was asked, which also runs on Windows (the shell runs the stub).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reportSeq } from "../lib/herdr-pane.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_SCRIPT = path.join(ROOT, "bin", "aify-herdr-state.sh").replace(/\\/g, "/");

/** A pane with a stub herdr. With `holdFirst`, the first report waits in Herdr until `release()`. */
function pane({ holdFirst = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-order-")).replace(/\\/g, "/");
  const log = `${dir}/reports.log`;
  const herdr = `${dir}/herdr`;
  const hold = holdFirst
    ? `if mkdir '${dir}/first' 2>/dev/null; then touch '${dir}/held'; while [ ! -e '${dir}/gate' ]; do sleep 0.05; done; fi\n`
    : "";
  fs.writeFileSync(herdr, `#!/bin/sh\n${hold}printf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: dir, HERDR_BIN_PATH: herdr,
    AIFY_HERDR_AGENT: "claude-aify", AIFY_HERDR_PANE_ID: "w1:p2",
    // What the launchers export; the old script took its lock only when this was set.
    AIFY_HERDR_LAUNCH: "42",
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
  /** Every report Herdr was asked for, as { state, seq }. */
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [])
    .map((line) => {
      const match = / --state (\S+) --seq (\S+)$/.exec(line);
      assert.ok(match, `a report went out without a seq, which Herdr drops after any seq'd one: ${line}`);
      return { state: match[1], seq: match[2] };
    });
  return { report, start, until, release, sent, dir };
}

test("every report carries when its hook fired, in microseconds, as Herdr's seq", () => {
  const { report, sent } = pane();
  report("working", "1790000000.000001");
  report("idle", "1790000000.000002");
  assert.deepEqual(sent(), [{ state: "working", seq: "1790000000000001" }, { state: "idle", seq: "1790000000000002" }]);
});

test("a locale comma and a short fraction read as the same microseconds", () => {
  const { report, sent } = pane();
  report("idle", "1790000000,5");
  report("working", "1790000000.400000");
  assert.deepEqual(sent().map((r) => r.seq), ["1790000000500000", "1790000000400000"]);
});

test("with no time passed in, the shell's own clock stamps the report to the microsecond", () => {
  // bash has EPOCHREALTIME; dash (Linux `sh`) falls back to GNU `date +%s%N`, and anything else to seconds.
  const { report, sent } = pane();
  const before = Date.now() * 1000;
  report("working");
  const [{ seq }] = sent();
  assert.match(seq, /^[0-9]{16}$/);
  assert.ok(Math.abs(Number(seq) - before) < 60_000_000, `${seq} is not this host's clock in microseconds`);
});

// REVIEW of 82b8331 (comms-senior-dev, 2026-09-28): on a shell with neither EPOCHREALTIME nor GNU
// `date +%N` (macOS /bin/sh), whole seconds ranked a hook BELOW the claim's millisecond seq made earlier
// in the same second, and Herdr drops the lower one. Driven here by sourcing the script with
// EPOCHREALTIME unset (bash drops its special meaning) and a BSD-style `date` first on PATH.
test("with neither EPOCHREALTIME nor GNU date, a report still outranks the claim made before it", () => {
  const { dir, sent } = pane();
  const stubs = `${dir}/bsd`;
  fs.mkdirSync(stubs);
  // BSD date: `+%s%N` prints a literal N, `+%s` whole seconds -- pinned to a second long past.
  fs.writeFileSync(`${stubs}/date`, "#!/bin/sh\ncase \"$1\" in +%s%N) echo 1790000000N ;; *) echo 1790000000 ;; esac\n", { mode: 0o755 });
  // A node that is missing is a stub that fails, SHADOWING the real one: dropping node's directory from
  // PATH drops /usr/bin on Linux, and `sh` with it.
  const noNode = `${dir}/no-node`;
  fs.mkdirSync(noNode);
  fs.writeFileSync(`${noNode}/node`, "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const run = (withNode) => {
    const result = spawnSync("sh", ["-c", 'unset EPOCHREALTIME; . "$0" "$1"', STATE_SCRIPT, "working"], {
      input: "", encoding: "utf8",
      env: { SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: dir, HERDR_BIN_PATH: `${dir}/herdr`, AIFY_HERDR_AGENT: "claude-aify",
        AIFY_HERDR_PANE_ID: "w1:p2", PATH: [stubs, ...(withNode ? [] : [noNode]), process.env.PATH].join(path.delimiter) },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const claim = BigInt(reportSeq(Date.now()));
  run(true);
  assert.ok(BigInt(sent()[0].seq) >= claim, `the report's seq ${sent()[0].seq} ranks below the claim's ${claim}`);
  // CONTROL: without node the same run falls to the stub's whole seconds, so the stub is what was read.
  run(false);
  assert.equal(sent()[1].seq, "1790000000000000");
});

// REVIEW (external, 2026-09-29): "Claude Code runs the hooks with /bin/sh, which is dash on Linux and has
// no EPOCHREALTIME, so the seq falls back to when node started, 32 to 160 ms late." Measured under a real
// dash (WSL Ubuntu): the ladder reaches GNU `date +%s%N` and never starts node. This holds that, under
// every POSIX shell this host has: `sh` is Git Bash on Windows and dash on Debian/Ubuntu, and dash is also
// asked for by name. Each run drops EPOCHREALTIME (bash loses its special meaning on unset; dash never
// had it) and shadows node with a stub that leaves a mark, so a ladder that asks node before date fails.
const SHELLS = ["sh", "bash", "dash"].map((shell) => ({
  shell, present: spawnSync(shell, ["-c", "exit 0"], { stdio: "ignore" }).status === 0,
}));
for (const { shell, present } of SHELLS) {
  test(`under ${shell} with no EPOCHREALTIME, GNU date stamps the report and node is never started`,
    { skip: present ? false : `${shell} is not on this host, so NOT verified here` }, () => {
      const { dir, sent } = pane();
      const stubs = `${dir}/node-marks`;
      fs.mkdirSync(stubs);
      fs.writeFileSync(`${stubs}/node`, `#!/bin/sh\ntouch '${dir}/node-ran'\nexit 127\n`, { mode: 0o755 });
      const before = BigInt(Date.now()) * 1000n;
      const result = spawnSync(shell, ["-c", 'unset EPOCHREALTIME; . "$0" "$1"', STATE_SCRIPT, "working"], {
        input: "", encoding: "utf8",
        env: { SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: dir, HERDR_BIN_PATH: `${dir}/herdr`, AIFY_HERDR_AGENT: "claude-aify",
          AIFY_HERDR_PANE_ID: "w1:p2", PATH: [stubs, process.env.PATH].join(path.delimiter) },
      });
      const after = (BigInt(Date.now()) + 1n) * 1000n;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(`${dir}/node-ran`), false, `${shell}: the ladder started node although date prints microseconds`);
      const [{ seq }] = sent();
      assert.match(seq, /^[0-9]{16}$/);
      assert.ok(BigInt(seq) >= before && BigInt(seq) <= after, `${shell}: ${seq} is not the time the hook ran (${before}..${after})`);
    });
}

// THE DEFECT THIS REPLACED. The script used to serialize reports under a per-pane lock. On Windows a
// report took 2.7 s, a lock left by one killed at the hook's 5 s timeout made the next wait 15.8 s, each
// of those was killed in turn, and a managed hermes pane read idle through every turn.
test("a report never waits on another one still in flight", async () => {
  const { start, until, release, sent } = pane({ holdFirst: true });
  const first = start("working", "1790000000.000001");
  try {
    await until("held");
    // No timer: a report that waited on the first could only give up, since the first is held until
    // release() below. So it must have LANDED while the first was still in Herdr.
    assert.equal(await start("idle", "1790000000.000002"), 0);
    assert.deepEqual(sent(), [{ state: "idle", seq: "1790000000000002" }], "the second report waited on the first");
  } finally {
    release();  // a failure above must not leave the held stub waiting for ever
  }
  assert.equal(await first, 0);
  assert.deepEqual(sent().map((r) => r.state), ["idle", "working"], "CONTROL: the held report still lands, with its older seq for Herdr to drop");
});

test("a lock directory an older version of this script left behind is not waited on", () => {
  // The old script waited on this ownerless lock, then broke it by removing it. Untouched means unread.
  const { report, sent, dir } = pane();
  const lock = `${dir}/aify-herdr-w1-p2.state.lock`;
  fs.mkdirSync(lock);
  report("working", "1790000000.000001");
  assert.deepEqual(sent().map((r) => r.state), ["working"]);
  assert.ok(fs.existsSync(lock), "the report waited on and broke the old lock");
});
