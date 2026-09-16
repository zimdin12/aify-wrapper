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
  // The lease it was handed, so a test can see whether the launcher believes it holds one.
  'printf \'%s\\n\' "${AIFY_AGENT_LEASE:-}" >> "$STUB_RUNTIME_LEASE"',
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
      STUB_RUNTIME_LEASE: path.join(dir, "runtime-lease"),
      ...extra,
    }),
    runtimeLeases: () => read(path.join(dir, "runtime-lease")).split("\n").slice(0, -1),
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

for (const client of ["claude", "codex", "hermes", "pi"]) {
  test(`${client}: an agent the command did not NAME never replaces its live instance, and a shell inside a session names none`, { skip: WIN }, async () => {
    // 2026-09-15: a bare `claude-aify` in a pane that had inherited comms-tech-lead's session environment
    // started as comms-tech-lead and replaced the live one.
    const w = world(client);
    const id = agentId();
    const first = spawn("bash", [w.launcher, "--aify-agent", id], { env: w.env({ STUB_EXIT: "hang", AIFY_START_INTENT: "start" }), detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => first.on("exit", resolve));
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(w.env().STUB_RUNTIME_PID) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    try {
      assert.ok(fs.existsSync(w.env().STUB_RUNTIME_PID), "the first runtime never started");

      // Every start below is `--resident`, a person at a terminal as in the incident: without a TTY a launcher
      // infers managed, which only starts, and a refusal would then prove nothing about how the agent was named.
      // The incident's launch from a clean shell: no flag, the identity from the environment. It is refused.
      const fromEnv = spawnSync("bash", [w.launcher, "--resident"], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", AIFY_AGENT_ID: id }), timeout: 60_000 });
      assert.equal(fromEnv.status, 75, `an identity from the environment was not refused:\n${fromEnv.stderr}`);
      assert.match(fromEnv.stderr, new RegExp(`${id} is already running .*did not name the agent.*--aify-agent ${id}`));
      assert.equal(w.runtimeRan().length, 1, "a refused start ran a runtime");
      assert.ok(alive(first.pid), "an identity from the environment stopped the live instance");

      // The same launch from a shell inside another running session: it names nobody, so it starts, anonymous.
      const inside = spawnSync("bash", [w.launcher, "--resident"], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", AIFY_AGENT_ID: id, AIFY_AGENT_LEASE: String(process.pid) }), timeout: 60_000 });
      assert.equal(inside.status, 0, inside.stderr);
      assert.match(inside.stderr, /belongs to a running agent session \(AIFY_AGENT_LEASE is set\), so it names no agent; ignored: AIFY_AGENT_ID/);
      assert.equal(w.runtimeRan().length, 2, "the anonymous start did not run its runtime");
      assert.ok(alive(first.pid), "a shell inside a session stopped the agent it inherited");
      assert.equal(JSON.parse(fs.readFileSync(w.leaseFile(id), "utf8")).instance.pid, first.pid, "the anonymous start took the lease");

      // CONTROL: the same person NAMING the agent replaces it.
      const named = spawnSync("bash", [w.launcher, "--resident", "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0" }), timeout: 60_000 });
      assert.equal(named.status, 0, named.stderr);
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
      assert.ok(gone, "a start that named its agent did not replace the live instance");
    } finally {
      try { process.kill(-first.pid, "SIGKILL"); } catch {}
    }
  });
}

const SCRIPT = process.platform === "win32" ? "" : spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" }).stdout.trim();

for (const client of ["claude", "hermes"]) {
  test(`${client}: a host-composed launch carrying another session's marker still only starts; so does a restore`, { skip: WIN || (!SCRIPT && "util-linux `script` is needed for a terminal") }, async () => {
    // External review, 2026-09-15: aify-env started inside a Claude Code session hands its workers
    // CLAUDE_CODE_CHILD_SESSION. The launcher dropped the host's `managed` and `start`; in the worker's terminal it
    // then read as a person, and the named start REPLACED the live instance. Run in a real terminal, as a worker is.
    const w = world(client);
    const id = agentId();
    const first = spawn("bash", [w.launcher, "--aify-agent", id], { env: w.env({ STUB_EXIT: "hang", AIFY_START_INTENT: "start" }), detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => first.on("exit", resolve));
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(w.env().STUB_RUNTIME_PID) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    try {
      assert.ok(fs.existsSync(w.env().STUB_RUNTIME_PID), "the first runtime never started");
      const inTerminal = (argv, env) => spawnSync(SCRIPT, ["-qec", argv.map((a) => `'${a}'`).join(" "), "/dev/null"], { encoding: "utf8", env, timeout: 60_000 });

      const hostComposed = { STUB_EXIT: "0", AIFY_SESSION_MODE: "managed", AIFY_START_INTENT: "start", CLAUDE_CODE_CHILD_SESSION: "1" };
      const worker = inTerminal(["bash", w.launcher, "--aify-agent", id], w.env(hostComposed));
      assert.equal(worker.status, 75, `a host-composed managed start with a leaked marker was not refused:\n${worker.stdout}`);
      assert.ok(alive(first.pid), "a host-composed managed start with a leaked marker stopped the live instance");
      assert.equal(w.runtimeRan().length, 1, "a refused start ran a runtime");

      // AND WITH THE HOST'S OWN AGENT ID LEAKED BESIDE THE MARKER (external review, 2026-09-16). An aify-env
      // older than the service's unset list hands a worker every name at once, so the environment names the
      // HOST's agent while the command names the worker: the mode is dropped as another session's, and the
      // named start read as a person and replaced the live instance.
      const leaked = inTerminal(["bash", w.launcher, "--aify-agent", id], w.env({ ...hostComposed, AIFY_AGENT_ID: "some-other-agent", AIFY_COMMS_AGENT_ID: "some-other-agent" }));
      assert.equal(leaked.status, 75, `a host-composed start carrying another agent's id was not refused:\n${leaked.stdout}`);
      assert.ok(alive(first.pid), "a host-composed start carrying another agent's id stopped the live instance");
      assert.equal(w.runtimeRan().length, 1, "a refused start ran a runtime");

      // CONTROL: the same terminal launch with no marker and no host values is a person naming the agent, and replaces.
      // Without it, a refusal above could be the terminal never reading as a person at all.
      const person = inTerminal(["bash", w.launcher, "--aify-agent", id], w.env({ STUB_EXIT: "0" }));
      assert.equal(person.status, 0, person.stdout);
      // Awaited, not probed: this process has not reaped its child while spawnSync held the event loop.
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
      assert.ok(gone, "control: a person naming the agent in a terminal did not replace it");
    } finally {
      try { process.kill(-first.pid, "SIGKILL"); } catch {}
    }
  });
}

test("a Herdr restore typed into a pane inside a session keeps its `start`", { skip: WIN }, async () => {
  const w = world("claude");
  const id = agentId();
  const first = spawn("bash", [w.launcher, "--aify-agent", id], { env: w.env({ STUB_EXIT: "hang", AIFY_START_INTENT: "start" }), detached: true, stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(w.env().STUB_RUNTIME_PID) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  try {
    // A restore names its agent and marks its start, in a pane that inherited another session's marker. The marker
    // drops an intent from the ENVIRONMENT; the one in the command line is the restore's own.
    const restore = spawnSync("bash", [w.launcher, "--aify-start-intent=start", "--resident", "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", CLAUDE_CODE_CHILD_SESSION: "1" }), timeout: 60_000 });
    assert.equal(restore.status, 75, `a restore in a pane inside a session replaced the live instance:\n${restore.stderr}`);
    assert.ok(alive(first.pid));
  } finally {
    try { process.kill(-first.pid, "SIGKILL"); } catch {}
  }
});

test("a launcher whose claim FAILED does not act as the lease holder", { skip: WIN }, () => {
  // External review, 2026-09-15: any non-75 status still exported the lease, and hermes' kill-prior -- which
  // reaps only for a holder -- then ran. A lease directory that is a FILE makes the claim fail.
  const w = world("claude");
  const id = agentId();
  const notADirectory = path.join(w.dir, "not-a-directory");
  fs.writeFileSync(notADirectory, "");
  const failed = spawnSync("bash", [w.launcher, "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", AIFY_AGENT_LEASE_DIR: notADirectory }), timeout: 60_000 });
  assert.equal(failed.status, 0, `a failed claim stopped the launch:\n${failed.stderr}`);
  assert.match(failed.stderr, /WARN: .*continuing without the one-instance guarantee/, "control: the claim really failed");
  const held = spawnSync("bash", [w.launcher, "--aify-agent", id], { encoding: "utf8", env: w.env({ STUB_EXIT: "0" }), timeout: 60_000 });
  assert.equal(held.status, 0, held.stderr);
  const [afterFailure, afterSuccess] = w.runtimeLeases();
  assert.equal(afterFailure, "", "a launcher whose claim failed handed its runtime a lease");
  assert.match(afterSuccess, /^\d+$/, "control: a launcher whose claim succeeded hands its runtime the lease");
});

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
