#!/usr/bin/env node
// What the installer produces, proven by rendering it and running it.
//
// A wrapper's failure mode is silence: it writes a launcher, reports success, and the launcher breaks
// at the moment somebody tries to start an agent with it. So these tests do not read the templates,
// they render them and execute the result.
//
// `--check` is what makes that safe. It resolves the whole configuration and exits above every side
// effect the wrapper would otherwise have — no MCP config written, no process reaped, no runtime
// started. The rule it exists for is older than this repo: running a launcher to see whether it
// worked once superseded a live environment bridge and reaped a fleet of managed workers.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const VERSION = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();

// Set, and reachable by nothing. A wrapper under test must never find a real service: it would
// register agents into whatever registry happened to be listening.
const NOWHERE = "http://127.0.0.2:1";

const CLIENTS = [
  { client: "claude", names: ["claude-aify"], runtime: "claude" },
  { client: "codex", names: ["codex-aify"], runtime: "codex" },
  { client: "hermes", names: ["hermes-aify"], runtime: "hermes" },
  { client: "pi", names: ["pi-aify", "omp-aify"], runtime: "omp" },
];

function render(client, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-wrapper-${client}-`));
  execFileSync("bash", [INSTALL, "--client", client, "--endpoint", NOWHERE, "--render-only", dir, ...extra], {
    encoding: "utf8",
  });
  return dir;
}

/** Run a rendered launcher with HOME and PATH sealed, so it cannot read this machine's state. */
function run(dir, name, args, env = {}) {
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (/^(AIFY_|HARNESS_|CLAUDE_|CODEX_|HERMES_|PI_|OMP_)/.test(k)) delete clean[k];
  }
  return spawnSync("bash", [path.join(dir, name), ...args], {
    encoding: "utf8",
    env: { ...clean, HOME: home.replace(/\\/g, "/"), ...env },
    timeout: 30_000,
  });
}

for (const { client, names, runtime } of CLIENTS) {
  test(`${client}: renders every launcher it promises`, () => {
    const dir = render(client);
    for (const n of names) assert.ok(fs.existsSync(path.join(dir, n)), `missing ${n}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(`${client}: the rendered launcher is valid bash`, () => {
    const dir = render(client);
    for (const n of names) {
      const res = spawnSync("bash", ["-n", path.join(dir, n)], { encoding: "utf8" });
      assert.equal(res.status, 0, `bash -n ${n}:\n${res.stderr}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(`${client}: no placeholder survives into the launcher`, () => {
    // The failure this prevents is quiet: install.sh exits 0, bash -n passes, and the launcher carries
    // a literal @@TOKEN@@ that only breaks when somebody starts an agent.
    const dir = render(client);
    for (const n of names) {
      const text = fs.readFileSync(path.join(dir, n), "utf8");
      const left = [...text.matchAll(/@@[A-Z0-9_]+@@/g)].map((m) => m[0]);
      assert.deepEqual(left, [], `${n} kept ${left.join(", ")}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(`${client}: template-only documentation never reaches the launcher`, () => {
    const dir = render(client);
    for (const n of names) {
      const leaked = fs.readFileSync(path.join(dir, n), "utf8").split("\n").filter((l) => l.startsWith("#|"));
      assert.deepEqual(leaked, [], `${n} leaked template docs`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test(`${client}: --check reports the configuration and starts nothing`, (t) => {
    const dir = render(client);
    try {
      const runtimePresent = spawnSync("bash", ["-c", `command -v ${runtime}`]).status === 0;
      if (!runtimePresent) {
        t.skip(`${runtime} is not installed here; --check would exit 127 by design`);
        return;
      }
      const r = run(dir, names[0], ["--check"], { HARNESS_IDENTITY: "probe-agent" });
      assert.equal(r.status, 0, `--check failed: ${r.stderr}`);
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, new RegExp(`${names[0]} ${VERSION.replace(/\./g, "\\.")}`), "must report its version");
      assert.match(out, /probe-agent/, "must report the identity it resolved");
      assert.match(out, /127\.0\.0\.2:1/, "must report the endpoint");
      assert.match(out, /nothing was started/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${client}: an emptied endpoint is refused with exit 78`, (t) => {
    const dir = render(client);
    try {
      const runtimePresent = spawnSync("bash", ["-c", `command -v ${runtime}`]).status === 0;
      if (!runtimePresent) {
        t.skip(`${runtime} is not installed here`);
        return;
      }
      // Explicitly empty, not unset: a host that cleared the endpoint must not have one substituted.
      const r = run(dir, names[0], ["--check"], { HARNESS_ENDPOINT: "" });
      assert.equal(r.status, 78, `expected 78, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /HARNESS_ENDPOINT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the installer refuses an unknown client rather than rendering nothing", () => {
  const res = spawnSync("bash", [INSTALL, "--client", "nope", "--endpoint", NOWHERE], { encoding: "utf8" });
  assert.equal(res.status, 78);
  assert.match(res.stderr, /unknown client/);
});

test("the installer refuses to guess an endpoint", () => {
  const res = spawnSync("bash", [INSTALL, "--client", "claude"], { encoding: "utf8" });
  assert.equal(res.status, 78);
  assert.match(res.stderr, /--endpoint is required/);
});

test("a missing placeholder is caught at render, not at launch", () => {
  // Hermes is the one with host-computed values; rendering it through render.sh directly, with none
  // supplied, must fail loudly rather than write a launcher carrying literal tokens.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-wrapper-missing-"));
  try {
    const res = spawnSync(
      "bash",
      [path.join(ROOT, "render.sh"), "hermes-aify.sh.in", path.join(dir, "hermes-aify"), `ENDPOINT=${NOWHERE}`],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 78, "an unsubstituted placeholder must fail the render");
    assert.match(res.stderr, /unsubstituted placeholders/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
