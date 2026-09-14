#!/usr/bin/env node
// codex-aify's app-server must start with the agent's identity and the service URL.
//
// THE DEFECT. codex runs hooks in the process that owns the session, which for codex-aify is the
// `codex app-server` the launcher starts, and it runs them with a cleared environment replayed from a
// snapshot that process took of its own (codex-rs rust-v0.154.0: hooks/src/registry.rs takes
// `std::env::vars_os()`, hooks/src/engine/command_runner.rs calls `env_clear()` and replays it). The
// launcher started the app-server BEFORE it parsed `--aify-agent` and exported AIFY_AGENT_ID,
// AIFY_AGENT_ROLE and AIFY_COMMS_URL, so a resident `codex-aify --aify-agent x` gave the TUI all three
// and the hooks none: every turn hook gated on them did nothing.
//
// These run the rendered launcher with a stub `codex` that records the environment of the app-server
// and of the TUI separately. What each process was given is the assertion.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32" && "the stub codex is a shell script, which Windows cannot spawn by path";
const NAMES = ["AIFY_AGENT_ID", "AIFY_AGENT_ROLE", "AIFY_COMMS_URL"];

function world({ endpoint = NOWHERE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-codex-env-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  for (const d of [out, stubs, path.join(home, ".codex", "sessions")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "sessions", "thread-1.jsonl"), "");

  const rendered = spawnSync("bash", [INSTALL, "--client", "codex", "--endpoint", endpoint,
    "--render-only", out, "--bridge-dir", path.join(dir, "bridge")], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  const seen = path.join(dir, "seen");
  // One JSON line per codex invocation: which process it was, its argv, and the three names (null when
  // unset, so "absent" and "empty" are told apart).
  const record = `'${process.execPath}' -e 'const fs=require("fs");fs.appendFileSync(process.argv[1], JSON.stringify({ role: process.argv[2], argv: process.argv.slice(3), env: Object.fromEntries(${JSON.stringify(NAMES)}.map(n => [n, process.env[n] ?? null])) }) + "\\n")'`;
  fs.writeFileSync(path.join(stubs, "codex"), [
    "#!/bin/bash",
    'for a in "$@"; do if [ "$a" = "app-server" ]; then',
    `  ${record} '${seen}' app-server "$@"`,
    '  url=""; prev=""; for b in "$@"; do [ "$prev" = "--listen" ] && url="$b"; prev="$b"; done',
    `  exec '${process.execPath}' -e 'require("net").createServer(s => s.end()).listen(Number(process.argv[1].split(":").pop()), "127.0.0.1")' "$url"`,
    "fi; done",
    `${record} '${seen}' tui "$@"`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, "aify-env"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(dir, "aify-env-calls")}'\nexit 0\n`, { mode: 0o755 });

  return {
    launcher: path.join(out, "codex-aify"),
    // SEALED like `env -i`: nothing from this process's environment reaches the launcher.
    env: (extra = {}) => ({ PATH: [stubs, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: home, TMPDIR: dir, ...extra }),
    seen: () => (fs.existsSync(seen) ? fs.readFileSync(seen, "utf8") : "").split("\n").filter(Boolean).map(line => JSON.parse(line)),
    hostAsked: () => (fs.existsSync(path.join(dir, "aify-env-calls")) ? fs.readFileSync(path.join(dir, "aify-env-calls"), "utf8") : ""),
  };
}

function launch(args, { env = {}, endpoint } = {}) {
  const w = world({ endpoint });
  const run = spawnSync("bash", [w.launcher, ...args], { encoding: "utf8", env: w.env(env), timeout: 60_000 });
  const byRole = (role) => w.seen().filter(row => row.role === role);
  return { ...w, run, server: byRole("app-server"), tui: byRole("tui") };
}

test("a resident `--aify-agent` launch gives the app-server what it gives the TUI", { skip: WIN }, () => {
  for (const args of [["--aify-agent", "probe-x"], ["--aify-agent=probe-x"], ["--agent-id", "probe-x", "--aify-role", "reviewer"]]) {
    const r = launch(args);
    assert.equal(r.run.status, 0, r.run.stderr);
    assert.equal(r.server.length, 1, `app-server not started once: ${r.run.stderr}`);
    assert.equal(r.tui.length, 1, `TUI not started once: ${r.run.stderr}`);
    const role = args.includes("--aify-role") ? "reviewer" : "coder";
    assert.deepEqual(r.tui[0].env, { AIFY_AGENT_ID: "probe-x", AIFY_AGENT_ROLE: role, AIFY_COMMS_URL: NOWHERE }, "control: the TUI");
    assert.deepEqual(r.server[0].env, r.tui[0].env, `app-server for ${args.join(" ")}`);
  }
});

test("NO AGENT: the app-server gets no agent id, and the URL the TUI gets", { skip: WIN }, () => {
  const r = launch([]);
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.deepEqual(r.tui[0].env, { AIFY_AGENT_ID: null, AIFY_AGENT_ROLE: null, AIFY_COMMS_URL: NOWHERE });
  assert.deepEqual(r.server[0].env, r.tui[0].env);
});

test("an agent recovered from the service by thread handle reaches the app-server too", { skip: WIN }, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: { "probe-r": { runtime: "codex", sessionHandle: "thread-1" } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const w = world({ endpoint });
    // Async, because this process serves the lookup the launcher makes.
    const child = spawn("bash", [w.launcher, "--resume", "thread-1"], { env: w.env(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    const code = await new Promise(resolve => child.on("exit", resolve));
    assert.equal(code, 0, stderr);
    const [app] = w.seen().filter(row => row.role === "app-server");
    const [tui] = w.seen().filter(row => row.role === "tui");
    assert.match(tui.argv.join(" "), / resume --include-non-interactive thread-1$/, stderr);
    assert.equal(tui.env.AIFY_AGENT_ID, "probe-r", `control: the lookup did not resolve:\n${stderr}`);
    assert.deepEqual(app.env, tui.env);
  } finally {
    server.close();
  }
});

test("MANAGED RESUME still resumes, and the app-server has the identity", { skip: WIN }, () => {
  const r = launch(["--managed", "--aify-agent", "probe-m", "--resume", "thread-1"], { env: { AIFY_MANAGED_VIA_WRAPPER: "1" } });
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.match(r.server[0].argv.join(" "), /--disable apps .*app-server --listen ws:/);
  assert.match(r.tui[0].argv.join(" "), /--dangerously-bypass-hook-trust resume --include-non-interactive thread-1$/);
  assert.equal(r.server[0].env.AIFY_AGENT_ID, "probe-m");
  assert.deepEqual(r.server[0].env, r.tui[0].env);
});

test("--shared still hands the session to the host, with the label, and runs no TUI here", { skip: WIN }, () => {
  const r = launch(["--aify-agent", "probe-s", "--resume", "thread-1", "--shared"]);
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.match(r.hostAsked(), /^run --service \S+ --launcher \S+codex-aify --label probe-s -- --aify-agent probe-s --resume thread-1$/m);
  assert.deepEqual(r.tui, []);
});
