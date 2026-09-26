#!/usr/bin/env node
// `<runtime>-aify --resume <handle>` without an agent id asks the bridge which agent owns the handle,
// and the runtime starts as that agent -- in all three launchers.
//
// THE GAP (aify-comms v0.7.1 review, W1). hermes-aify's lookup had no behavioural test: claude's is
// run by aify-comms against a keyed service and codex's by a pin, and hermes' was correct by reading
// only. The three are run the same way here, so none of them is.
//
// AND WITH MSYS PATH REWRITING OFF (W04). `node "@@BRIDGE_DIR@@/agent-for-handle.mjs"` handed native
// Windows node the bridge directory as rendered, `/c/Users/...`. Node can open that only while Git
// Bash rewrites the argument on the way; with `MSYS_NO_PATHCONV=1` -- which hermes' own tool shell
// exports -- node looked for `C:\c\Users\...`, the lookup failed in silence, and the resumed session
// came up anonymous.
//
// The REAL rendered launchers run with the bridge directory rendered MSYS-style on Windows, as
// aify-comms' installer renders it. The bridge's `agent-for-handle.mjs` is a stub that answers for one
// handle; each runtime is a stub that records the environment it was started with. Nothing contacts a
// service: the endpoint is 127.0.0.2:1.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";
const WIN = process.platform === "win32";
const KNOWN = "11111111-2222-3333-4444-555555555555";
const UNKNOWN = "99999999-8888-7777-6666-555555555555";

// Bash named outright, in the form this platform's node can spawn: the PATH handed to the launcher
// below is bash's, not node's. An absolute path on Linux too: a bare "bash" made BASH_DIR ".", so the
// launcher found bash and coreutils only where node happens to sit in /usr/bin (v0.7.2, external
// review: 9 failures under an nvm node).
const BASH = WIN
  ? execFileSync("bash", ["-lc", 'cygpath -w "$(command -v bash)"'], { encoding: "utf8" }).trim()
  : execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const BASH_DIR = path.dirname(BASH);
/** A path as the launcher's shell writes it: MSYS-style on Windows, which is what aify-comms bakes. */
const shellPath = (p) => (WIN ? execFileSync(BASH, ["-c", 'cygpath -u "$1"', "_", p], { encoding: "utf8" }).trim() : p);

// STUB LOOKUP. Answers `<runtime>-recovered` for the known handle only, and says what it was asked.
const LOOKUP = [
  'import fs from "node:fs";',
  "const [endpoint, runtime, handle] = process.argv.slice(2);",
  "fs.appendFileSync(process.env.STUB_LOOKUPS, JSON.stringify({ endpoint, runtime, handle }) + '\\n');",
  `if (handle === ${JSON.stringify(KNOWN)}) process.stdout.write(runtime + "-recovered\\n");`,
  "",
].join("\n");

/** A stub runtime: records its environment, except codex's app-server, which must listen. */
function runtimeStub(node) {
  return [
    "#!/bin/bash",
    'for a in "$@"; do if [ "$a" = "app-server" ]; then',
    '  url=""; prev=""; for b in "$@"; do [ "$prev" = "--listen" ] && url="$b"; prev="$b"; done',
    `  exec "${node}" -e 'require("net").createServer(s => s.end()).listen(Number(process.argv[1].split(":").pop()), "127.0.0.1")' "$url"`,
    "fi; done",
    'env > "$STUB_RUNTIME_ENV"',
    "exit 0",
    "",
  ].join("\n");
}

/** Render one launcher with a stub bridge and a stub runtime, in a fresh directory. */
function world(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-resume-${client}-`));
  const [out, stubs, home, bridge] = ["out", "stubs", "home", "bridge"].map((d) => path.join(dir, d));
  for (const d of [out, stubs, home, bridge]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bridge, "agent-for-handle.mjs"), LOOKUP);
  // claude-aify keeps a `--resume` only for a session it can find on disk; codex-aify reads CODEX_HOME.
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  for (const id of [KNOWN, UNKNOWN]) fs.writeFileSync(path.join(home, ".claude", "projects", "p", `${id}.jsonl`), "{}\n");
  fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
  const rendered = spawnSync(BASH, [INSTALL, "--client", client, "--endpoint", NOWHERE,
    "--render-only", out, "--bridge-dir", shellPath(bridge)], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);
  const runtime = client === "claude" ? "claude" : client;
  fs.writeFileSync(path.join(stubs, runtime), runtimeStub(shellPath(process.execPath)), { mode: 0o755 });
  return { dir, home, stubs, launcher: path.join(out, `${client}-aify`) };
}

/** Run the launcher with nothing of this machine's environment but what a shell needs. */
function resume(client, handle, { rewriting, extraArgs = [] }) {
  const w = world(client);
  const lookups = path.join(w.dir, "lookups");
  const runtimeEnv = path.join(w.dir, "runtime-env");
  const env = {
    PATH: [w.stubs, path.dirname(process.execPath), BASH_DIR].join(WIN ? ";" : ":"),
    HOME: w.home,
    USERPROFILE: w.home,
    CODEX_HOME: path.join(w.home, ".codex"),
    TMPDIR: w.dir,
    TEMP: w.dir,
    TMP: w.dir,
    AIFY_HERMES_SKIP_NODE_CHECK: "1",
    AIFY_HERMES_DISABLE_PLUGIN: "1",
    STUB_LOOKUPS: lookups,
    STUB_RUNTIME_ENV: runtimeEnv,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(rewriting ? {} : { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }),
  };
  const run = spawnSync(BASH, [w.launcher, "--resume", handle, ...extraArgs], { encoding: "utf8", env, timeout: 60_000 });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const started = Object.fromEntries(read(runtimeEnv).split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const asked = read(lookups).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  fs.rmSync(w.dir, { recursive: true, force: true });
  return { run, started, asked };
}

//: hermes is given a subcommand so it runs the stub directly instead of its gateway host; the lookup
//: happens before that choice either way.
const CASES = [
  ["claude", "claude-code-recovered", []],
  ["codex", "codex-recovered", []],
  ["hermes", "hermes-recovered", ["chat"]],
];

for (const [client, expected, extraArgs] of CASES) {
  test(`${client}-aify --resume finds its agent through the bridge`, () => {
    const { run, started, asked } = resume(client, KNOWN, { rewriting: true, extraArgs });
    assert.ok(Object.keys(started).length, `the runtime never started:\n${run.stdout}\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ID, expected,
      `the lookup did not reach the bridge (asked: ${JSON.stringify(asked)}):\n${run.stderr}`);
    assert.deepEqual(asked.map((a) => [a.endpoint.replace(/\/$/, ""), a.runtime, a.handle]),
      [[NOWHERE, expected.replace(/-recovered$/, ""), KNOWN]], "the lookup asked another endpoint, runtime or handle");
  });

  test(`${client}-aify --resume finds its agent with MSYS path rewriting off`, () => {
    const { run, started, asked } = resume(client, KNOWN, { rewriting: false, extraArgs });
    assert.ok(Object.keys(started).length, `the runtime never started:\n${run.stdout}\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ID, expected,
      `node could not open the bridge's helper (asked: ${JSON.stringify(asked)}):\n${run.stderr}`);
  });

  test(`CONTROL: ${client}-aify stays anonymous for a handle the service does not know`, () => {
    const { run, started, asked } = resume(client, UNKNOWN, { rewriting: true, extraArgs });
    assert.ok(Object.keys(started).length, `the runtime never started:\n${run.stdout}\n${run.stderr}`);
    assert.ok(asked.length > 0, `positive control: the lookup never ran:\n${run.stderr}`);
    assert.equal(started.AIFY_AGENT_ID, undefined);
  });
}
