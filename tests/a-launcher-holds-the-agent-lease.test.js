#!/usr/bin/env node
// Every launcher holds its agent's lease while its runtime runs (bin/aify-lease.sh, lib/agent-lease.mjs).
//
// Rendered launchers, a stub runtime that hangs until killed, and a sealed lease directory. The
// assertions are what the operator asked for: a second automatic start of the same agent does not run
// a second runtime, an explicit start replaces the first, and a clean exit gives the lease back.
// agent-lease.test.js and an-agent-runs-once-per-host.test.js prove the decisions; this proves every
// launcher actually asks, on the path it really runs.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32" && "the stubs are shell scripts, which Windows cannot spawn by path";
const BASH_DIR = process.platform === "win32" ? "" : path.dirname(spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim());

// A runtime that records its start and hangs (STUB_EXIT=hang) or exits. codex's app-server listens.
const RUNTIME = [
  "#!/bin/bash",
  'for a in "$@"; do if [ "$a" = "app-server" ]; then',
  '  url=""; prev=""; for b in "$@"; do [ "$prev" = "--listen" ] && url="$b"; prev="$b"; done',
  `  exec '${process.execPath}' -e 'require("net").createServer(s => s.end()).listen(Number(process.argv[1].split(":").pop()), "127.0.0.1")' "$url"`,
  "fi; done",
  'printf \'%s\\n\' "$*" >> "$STUB_RUNTIME_ARGV"',
  'case "${STUB_EXIT:-0}" in',
  '  hang) printf "%s" $$ > "$STUB_RUNTIME_PID"; exec sleep 60 ;;',
  '  *) exit "$STUB_EXIT" ;;',
  "esac",
  "",
].join("\n");

const MANAGED_HOST = [
  "const cmd = process.argv[2];",
  "if (cmd === 'ensure-host') process.stdout.write('{\"port\":1,\"token\":\"t\",\"wsUrl\":\"ws://127.0.0.2:1/?token=t\"}\\n');",
  "if (cmd === 'run') setTimeout(() => {}, 60000);",
  "",
].join("\n");

function world(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-lease-${client}-`));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  for (const d of [out, stubs, path.join(home, ".codex", "sessions"), path.join(bridge, "node_modules")]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(ROOT, path.join(bridge, "node_modules", "aify-wrapper"), "dir");
  fs.writeFileSync(path.join(bridge, "hermes-managed-host.js"), MANAGED_HOST);
  const rendered = spawnSync("bash", [INSTALL, "--client", client, "--endpoint", NOWHERE, "--render-only", out, "--bridge-dir", bridge],
    { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);
  // pi-aify runs the `omp` CLI; every other launcher runs a CLI named for its client.
  fs.writeFileSync(path.join(stubs, client === "pi" ? "omp" : client), RUNTIME, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, "aify-env"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(dir, "aify-env-calls")}'\nexit 0\n`, { mode: 0o755 });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const leases = path.join(dir, "leases");
  return {
    dir,
    launcher: path.join(out, `${client}-aify`),
    leaseFile: (id) => path.join(leases, `${id}.json`),
    env: (extra = {}) => ({
      PATH: [stubs, path.dirname(process.execPath), BASH_DIR, "/usr/bin", "/bin"].join(":"),
      HOME: home,
      TMPDIR: dir,
      AIFY_HERMES_SKIP_NODE_CHECK: "1",
      AIFY_AGENT_LEASE_DIR: leases,
      STUB_RUNTIME_ARGV: path.join(dir, "runtime-argv"),
      STUB_RUNTIME_PID: path.join(dir, "runtime-pid"),
      ...extra,
    }),
    hostAsked: () => read(path.join(dir, "aify-env-calls")),
    runtimeRan: () => read(path.join(dir, "runtime-argv")).split("\n").filter(Boolean),
  };
}

const agentId = () => `lease-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const DETACHED = { codex: "app-server", hermes: "delivery-loop" };

for (const client of ["claude", "codex", "hermes", "pi"]) {
  test(`${client}: a second automatic start runs no runtime; an explicit one replaces the first; exit releases`, { skip: WIN }, async () => {
    const w = world(client);
    const id = agentId();
    const first = spawn("bash", [w.launcher, "--aify-agent", id], { env: w.env({ STUB_EXIT: "hang", AIFY_START_INTENT: "start" }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    first.stdout.on("data", (d) => { output += d; });
    first.stderr.on("data", (d) => { output += d; });
    const exited = new Promise((resolve) => first.on("exit", resolve));
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(w.env().STUB_RUNTIME_PID) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    try {
      assert.ok(fs.existsSync(w.env().STUB_RUNTIME_PID), `the first runtime never started:\n${output}`);
      const record = JSON.parse(fs.readFileSync(w.leaseFile(id), "utf8"));
      assert.equal(record.instance.pid, first.pid, "the lease names the launcher, not a stub or a child");
      assert.deepEqual([record.instance.runtime, record.instance.intent], [client === "claude" ? "claude-code" : client, "start"]);
      if (DETACHED[client]) assert.ok(record.instance.attached.some((e) => e.kind === DETACHED[client]), JSON.stringify(record));

      const second = spawnSync("bash", [w.launcher, "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", AIFY_START_INTENT: "start" }), timeout: 60_000 });
      assert.equal(second.status, 75, `a second automatic start was not refused:\n${second.stderr}`);
      assert.match(second.stderr, new RegExp(`${id} is already running`));
      assert.equal(w.runtimeRan().length, 1, "a refused start ran a runtime");
      assert.ok(alive(first.pid), "a refused start stopped the first launcher");

      // A launcher run INSIDE the live instance -- it inherits that instance's lease -- is refused even when
      // explicit: replacing would end its own ancestor. Before this, a resident agent's shell did exactly that.
      const nested = spawnSync("bash", [w.launcher, "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", AIFY_START_INTENT: "replace", AIFY_AGENT_LEASE: String(record.instance.pid) }), timeout: 60_000 });
      assert.equal(nested.status, 75, `a nested start was not refused:\n${nested.stderr}`);
      assert.match(nested.stderr, /runs inside .* own live instance/);
      assert.equal(w.runtimeRan().length, 1, "a nested start ran a runtime");
      assert.ok(alive(first.pid), "a nested start stopped the instance it runs inside");

      // The intent as a LAUNCHER ARGUMENT (what a Herdr restore passes): honoured, and never handed on.
      const byFlag = spawnSync("bash", [w.launcher, "--aify-start-intent=start", "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0" }), timeout: 60_000 });
      assert.equal(byFlag.status, 75, `a start marked by the argument was not refused:\n${byFlag.stderr}`);
      assert.equal(w.runtimeRan().length, 1, "a refused start ran a runtime");

      const third = spawnSync("bash", [w.launcher, "--aify-start-intent=replace", "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0" }), timeout: 60_000 });
      assert.equal(third.status, 0, third.stderr);
      assert.equal(w.runtimeRan().length, 2, "the explicit start did not run its runtime");
      assert.ok(!w.runtimeRan().some((line) => line.includes("--aify-start-intent")), `the runtime was handed the lease's argument: ${w.runtimeRan()}`);
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
      assert.ok(gone, "the first launcher survived an explicit start");
      if (client === "pi") {
        // pi execs, so nothing releases: the record is left naming a dead launcher, which the next claim reads as gone.
        assert.ok(fs.existsSync(w.leaseFile(id)));
      } else {
        assert.equal(fs.existsSync(w.leaseFile(id)), false, "a clean exit did not give the lease back");
      }
    } finally {
      try { process.kill(-first.pid, "SIGKILL"); } catch {}
    }
  });
}

test("NO AGENT ID and --shared claim nothing", { skip: WIN }, () => {
  const w = world("claude");
  const plain = spawnSync("bash", [w.launcher], { encoding: "utf8", env: w.env({ STUB_EXIT: "0" }), timeout: 60_000 });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(w.runtimeRan().length, 1, "control: the plain launch ran");
  assert.equal(fs.existsSync(path.dirname(w.leaseFile("x"))), false, "a launch with no agent wrote a lease");
  // --shared hands the start to the host, whose run of this launcher is the one that claims.
  for (const client of ["claude", "codex", "hermes", "pi"]) {
    const s = world(client);
    const id = agentId();
    const shared = spawnSync("bash", [s.launcher, "--aify-agent", id, "--shared"], { encoding: "utf8", env: s.env({ STUB_EXIT: "0" }), timeout: 60_000 });
    assert.equal(shared.status, 0, `${client}: ${shared.stderr}`);
    assert.match(s.hostAsked(), /^run --service /m, `control: ${client} handed the start to the host`);
    assert.equal(fs.existsSync(s.leaseFile(id)), false, `${client}: the handing-off launch claimed the lease`);
  }
});

test("the claim comes before every older reap of the same agent, so a refused start has ended nothing", () => {
  // claude's managed reap and hermes' kill-prior both stop this agent's previous processes. Run before the
  // claim, an automatic start ended a live instance that the claim would then have refused.
  const order = { claude: 'node "@@BRIDGE_DIR@@/reap-managed-claude.js"', hermes: '  aify_hermes_kill_prior "$HERMES_AIFY_AGENT_ID"' };
  for (const [client, reap] of Object.entries(order)) {
    const source = fs.readFileSync(path.join(ROOT, "wrappers", `${client}-aify.sh.in`), "utf8");
    const claim = source.indexOf('  aify_lease_claim "@@BRIDGE_DIR@@"');
    const reapAt = source.indexOf(reap);
    assert.ok(claim > 0 && reapAt > 0, `${client}: control, both call sites are found`);
    assert.ok(claim < reapAt, `${client}: the reap runs before the claim`);
  }
  // A --shared launch claims nothing (the host's own run claims), so it must reap nothing either.
  const claude = fs.readFileSync(path.join(ROOT, "wrappers", "claude-aify.sh.in"), "utf8");
  const reapGuard = claude.split("\n").find((line) => line.startsWith("if ") && line.includes('"$AIFY_SESSION_MODE" = "managed"') && line.includes("CLAUDE_RESUME_ID"));
  assert.ok(reapGuard, "control: the managed reap's condition is found");
  assert.match(reapGuard, /"\$CLAUDE_AIFY_SHARED" != true/, "a --shared launch runs the managed reap without claiming");
});
