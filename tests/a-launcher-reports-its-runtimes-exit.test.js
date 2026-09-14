#!/usr/bin/env node
// When the runtime a launcher started exits, the launcher says so: a turn-end to the service and
// idle to a claimed Herdr pane.
//
// THE DEFECT. Turn state comes from the runtime's own hooks, and no hook fires when the runtime
// itself goes away. A claude killed mid-turn, a codex TUI that exits non-zero under `set -e`, a
// terminal closed on a hermes session: each left the agent reading `working` on the dashboard and
// on the Herdr dot until something else happened to clear it. The launcher is the parent that
// waits on the child, so it is the one process that sees every one of those exits.
//
// These run the rendered launchers with a stub runtime that exits the way the test says, a stub
// `agent-state-event.mjs` in the bridge directory that records its argv, and a stub `herdr` that
// records what it was asked. What reaches the stubs, and the launcher's own exit status, are the
// assertions.

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
// NOT RUN ON WINDOWS: the stubs are shell scripts spawned by path and the bridge is a symlink.
const WIN = process.platform === "win32" && "the stubs are shell scripts, which Windows cannot spawn by path";
const IN_A_PANE = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" };
const BASH_DIR = path.dirname(spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim());

// STUB RUNTIME. STUB_EXIT picks how it ends: a number, `kill` (SIGKILL to itself) or `hang` (waits to
// be signalled). Codex's app-server invocation is the one exception: it listens on the port it is
// told to, because the launcher waits for that before starting the TUI.
const RUNTIME = [
  "#!/bin/bash",
  'for a in "$@"; do if [ "$a" = "app-server" ]; then',
  '  url=""; prev=""; for b in "$@"; do [ "$prev" = "--listen" ] && url="$b"; prev="$b"; done',
  `  exec '${process.execPath}' -e 'require("net").createServer(s => s.end()).listen(Number(process.argv[1].split(":").pop()), "127.0.0.1")' "$url"`,
  "fi; done",
  'printf \'%s\\n\' "$*" >> "$STUB_RUNTIME_ARGV"',
  'case "${STUB_EXIT:-0}" in',
  "  kill) kill -KILL $$ ;;",
  '  hang) printf "%s" $$ > "$STUB_RUNTIME_PID"; exec sleep 30 ;;',
  '  *) exit "$STUB_EXIT" ;;',
  "esac",
  "",
].join("\n");

// STUB BRIDGE EVENT SCRIPT. Records what it was asked, then tries to print into the terminal, which the
// launcher must not let through. STUB_EVENT_HANG holds it open to prove the exit is bounded.
const EVENT_SCRIPT = [
  'import fs from "node:fs";',
  "fs.appendFileSync(process.env.STUB_EVENTS, JSON.stringify({ argv: process.argv.slice(2), agent: process.env.AIFY_AGENT_ID ?? null }) + '\\n');",
  "process.stdout.write('LEAK-OUT');",
  "process.stderr.write('LEAK-ERR');",
  "if (process.env.STUB_EVENT_HANG) { fs.writeFileSync(process.env.STUB_EVENT_HANG, String(process.pid)); setTimeout(() => {}, 20000); }",
  "",
].join("\n");

// hermes-aify's agent-id branch asks this for a gateway host before it starts the TUI.
const MANAGED_HOST = [
  "const cmd = process.argv[2];",
  "if (cmd === 'ensure-host') process.stdout.write('{\"port\":1,\"token\":\"t\",\"wsUrl\":\"ws://127.0.0.2:1/?token=t\"}\\n');",
  "if (cmd === 'resolve-session' && process.argv.includes('--explicit')) process.stdout.write(process.argv[process.argv.indexOf('--explicit') + 1] + '\\n');",
  "else if (cmd === 'resolve-session' && process.env.STUB_RESOLVE) process.stdout.write(process.env.STUB_RESOLVE + '\\n');",
  "",
].join("\n");

/** Render one launcher into a fresh directory with its stubs. */
function world(client, { eventScript = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-exit-${client}-`));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const bridge = path.join(dir, "bridge");
  for (const d of [out, stubs, path.join(home, ".codex", "sessions"), path.join(bridge, "node_modules")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "sessions", "thread-1.jsonl"), "");
  fs.symlinkSync(ROOT, path.join(bridge, "node_modules", "aify-wrapper"), "dir");
  if (eventScript) fs.writeFileSync(path.join(bridge, "agent-state-event.mjs"), EVENT_SCRIPT);
  fs.writeFileSync(path.join(bridge, "hermes-managed-host.js"), MANAGED_HOST);

  const rendered = spawnSync("bash", [INSTALL, "--client", client, "--endpoint", NOWHERE,
    "--render-only", out, "--bridge-dir", bridge], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  fs.writeFileSync(path.join(stubs, client), RUNTIME, { mode: 0o755 });
  const calls = path.join(dir, "herdr-calls");
  const herdr = path.join(stubs, "herdr");
  fs.writeFileSync(herdr, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${calls}'`,
    'if [ "$1 $2" = "pane list" ]; then',
    `  printf '%s' '{"result":{"panes":[{"pane_id":"w1:p2","terminal_id":"term-1"}]}}'`,
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, "aify-env"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(dir, "aify-env-calls")}'\nexit 0\n`, { mode: 0o755 });

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  return {
    launcher: path.join(out, `${client}-aify`),
    env: (extra = {}) => ({
      PATH: [stubs, path.dirname(process.execPath), BASH_DIR, "/usr/bin", "/bin"].join(":"),
      HOME: home,
      TMPDIR: dir,
      HERDR_BIN_PATH: herdr,
      AIFY_HERMES_SKIP_NODE_CHECK: "1",
      STUB_EVENTS: path.join(dir, "events"),
      STUB_RUNTIME_ARGV: path.join(dir, "runtime-argv"),
      STUB_RUNTIME_PID: path.join(dir, "runtime-pid"),
      ...extra,
    }),
    events: () => read(path.join(dir, "events")).split("\n").filter(Boolean).map(line => JSON.parse(line)),
    reports: () => read(calls).split("\n").filter(line => line.startsWith("pane report-agent")),
    runtimeRan: () => read(path.join(dir, "runtime-argv")).split("\n").filter(Boolean),
    hostAsked: () => read(path.join(dir, "aify-env-calls")),
    dir,
  };
}

// A unique id, so hermes-aify's kill-prior (pkill -f on the agent id) cannot match anything real.
const agentId = () => `exit-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function launch(client, { args = [], env = {}, eventScript = true } = {}) {
  const w = world(client, { eventScript });
  const run = spawnSync("bash", [w.launcher, ...args], { encoding: "utf8", env: w.env(env), timeout: 60_000 });
  return { ...w, run };
}

const NO_LEAK = (run) => {
  assert.ok(!`${run.stdout}${run.stderr}`.includes("LEAK"), `the exit report printed into the terminal:\n${run.stdout}\n${run.stderr}`);
};

// Every child path each launcher runs its runtime on, with the runtime argv that proves the path was
// the one taken. hermes' three are all in its agent-id branch.
const CHILD_PATHS = [
  ["claude", "claude", [], {}, /--dangerously-load-development-channels/],
  ["codex", "codex (fresh)", [], {}, /^--remote ws:\S+ --dangerously-bypass-approvals-and-sandbox$/],
  ["codex", "codex (resume)", ["--resume", "thread-1"], {}, / resume --include-non-interactive thread-1$/],
  ["hermes", "hermes (fresh session)", [], {}, /^--tui --yolo$/],
  ["hermes", "hermes (stored session)", [], { STUB_RESOLVE: "sess-1" }, /^--tui --resume sess-1 /],
  ["hermes", "hermes (explicit resume)", ["--resume", "sess-2"], {}, /^--tui --resume sess-2 /],
];

for (const [client, label, args, extraEnv, argvShape] of CHILD_PATHS) {
  test(`${label}: one turn-end per exit, whatever the runtime's exit status`, { skip: WIN }, () => {
    for (const [exit, status] of [["0", 0], ["3", 3], ["kill", 137]]) {
      const id = agentId();
      const r = launch(client, { args: ["--aify-agent", id, ...args], env: { STUB_EXIT: exit, ...extraEnv } });
      assert.equal(r.runtimeRan().length, 1, `the runtime did not run exactly once (${exit}):\n${r.run.stderr}`);
      assert.match(r.runtimeRan()[0], argvShape, "the launcher took a different path than this case names");
      assert.equal(r.run.status, status, `exit status not preserved for ${exit}:\n${r.run.stderr}`);
      assert.deepEqual(r.events(), [{ argv: ["turn-end"], agent: id }], `exit ${exit}`);
      NO_LEAK(r.run);
    }
  });

  test(`${label}: a claimed pane reads idle once the runtime has exited`, { skip: WIN }, () => {
    const r = launch(client, { args: ["--aify-agent", agentId(), ...args], env: { ...IN_A_PANE, STUB_EXIT: "5", ...extraEnv } });
    assert.equal(r.run.status, 5, r.run.stderr);
    // The claim reports idle once at launch; the exit adds exactly one more.
    assert.deepEqual(r.reports(), [
      `pane report-agent w1:p2 --source herdr:aify --agent ${client}-aify --state idle`,
      `pane report-agent w1:p2 --source herdr:aify --agent ${client}-aify --state idle`,
    ]);
  });
}

for (const client of ["claude", "codex", "hermes"]) {
  test(`${client}: closing the terminal still reports the exit, once`, { skip: WIN }, async () => {
    const w = world(client);
    const id = agentId();
    const env = w.env({ ...IN_A_PANE, STUB_EXIT: "hang" });
    // Its own process group, so the hangup reaches the launcher and the runtime together, as a
    // terminal closing does.
    const child = spawn("bash", [w.launcher, "--aify-agent", id], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", d => { output += d; });
    child.stderr.on("data", d => { output += d; });
    const exited = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(env.STUB_RUNTIME_PID) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(env.STUB_RUNTIME_PID), `the runtime never started:\n${output}`);
    process.kill(-child.pid, "SIGHUP");
    const { code, signal } = await exited;
    assert.ok(code === 129 || signal === "SIGHUP" || code !== 0, `launcher exited cleanly after a hangup: ${code} ${signal}`);
    // The report runs in the background of a dying shell; give it its bound to land.
    const until = Date.now() + 5_000;
    while (w.events().length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(w.events(), [{ argv: ["turn-end"], agent: id }]);
    assert.equal(w.reports().filter(line => line.endsWith("--state idle")).length, 2, w.reports().join("\n"));
    assert.ok(!output.includes("LEAK"), output);
  });
}

// ── negative controls ─────────────────────────────────────────────────────────────────────────────

test("NO AGENT ID: nothing is sent to the service, and the exit status is still the runtime's", { skip: WIN }, () => {
  for (const client of ["claude", "codex"]) {
    const r = launch(client, { env: { STUB_EXIT: "4" } });
    assert.equal(r.runtimeRan().length, 1, r.run.stderr);
    assert.equal(r.run.status, 4, r.run.stderr);
    assert.deepEqual(r.events(), [], client);
    // CONTROL, same world shape: with an id it does send.
    const c = launch(client, { args: ["--aify-agent", agentId()], env: { STUB_EXIT: "4" } });
    assert.equal(c.events().length, 1, `${client}: the control sent nothing, so this test cannot see a send`);
  }
});

test("AN OLDER BRIDGE with no agent-state-event.mjs: nothing runs, nothing prints, status preserved", { skip: WIN }, () => {
  for (const client of ["claude", "codex", "hermes"]) {
    const r = launch(client, { args: ["--aify-agent", agentId()], env: { STUB_EXIT: "6" }, eventScript: false });
    assert.equal(r.runtimeRan().length, 1, r.run.stderr);
    assert.equal(r.run.status, 6, r.run.stderr);
    assert.deepEqual(r.events(), []);
    assert.ok(!/agent-state-event|No such file|Cannot find module/.test(r.run.stderr), `${client}: ${r.run.stderr}`);
  }
});

test("OUTSIDE HERDR the exit reports nothing to Herdr, even with a pane's variables inherited", { skip: WIN }, () => {
  for (const client of ["claude", "codex", "hermes"]) {
    // A shell inside another agent's pane carries its AIFY_HERDR_AGENT and HERDR_PANE_ID. Without
    // HERDR_ENV this launcher claimed nothing, so that pane is not its to report to.
    const inherited = { STUB_EXIT: "0", AIFY_HERDR_AGENT: "someone-else", HERDR_PANE_ID: "w1:p2" };
    const r = launch(client, { args: ["--aify-agent", agentId()], env: inherited });
    assert.equal(r.events().length, 1, r.run.stderr);
    assert.deepEqual(r.reports(), [], client);
  }
});

test("A LAUNCHER THAT EXECS AWAY reports nothing: --shared, and hermes' passthrough", { skip: WIN }, () => {
  for (const client of ["claude", "codex", "hermes"]) {
    const r = launch(client, { args: ["--aify-agent", agentId(), "--shared"], env: IN_A_PANE });
    assert.match(r.hostAsked(), /^run /, `${client}: --shared did not reach aify-env, so this proves nothing:\n${r.run.stderr}`);
    assert.deepEqual(r.events(), [], client);
    assert.equal(r.reports().length, 1, `${client}: only the claim's own report: ${r.reports().join("\n")}`);
  }
  const p = launch("hermes", { args: ["--aify-agent", agentId(), "model", "list"], env: { STUB_EXIT: "0" } });
  assert.deepEqual(p.runtimeRan(), ["model list"], p.run.stderr);
  assert.deepEqual(p.events(), []);
});

test("A HUNG REPORT does not hold the launcher's exit for more than a few seconds", { skip: WIN }, () => {
  for (const client of ["claude", "codex", "hermes"]) {
    const w = world(client);
    const hang = path.join(w.dir, "event-pid");
    const timed = (extra) => {
      const started = Date.now();
      const run = spawnSync("bash", [w.launcher, "--aify-agent", agentId()], { encoding: "utf8", env: w.env({ STUB_EXIT: "0", ...extra }), timeout: 60_000 });
      assert.equal(run.status, 0, run.stderr);
      return Date.now() - started;
    };
    try {
      const normal = timed({});
      const hung = timed({ STUB_EVENT_HANG: hang });
      assert.equal(w.events().length, 2);
      assert.ok(fs.existsSync(hang), `${client}: the hung report never started, so this measured nothing`);
      // The script stops waiting after about 3 s; the rest is slack for a loaded host. Unbounded, the
      // stub holds it for 20 s.
      assert.ok(hung - normal < 6_000, `${client}: a hung report held the exit ${hung - normal} ms longer`);
    } finally {
      if (fs.existsSync(hang)) try { process.kill(Number(fs.readFileSync(hang, "utf8")), "SIGKILL"); } catch {}
    }
  }
});
