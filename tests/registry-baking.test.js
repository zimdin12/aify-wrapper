#!/usr/bin/env node
// What the launcher was built from, baked in and readable without running anything.
//
// The registry is read at INSTALL. That is a deliberate trade — a launcher that parsed JSON on every
// start would pay it on every start, and hermes gives MCP discovery 0.75s — and it has one
// consequence: a service registered after a launcher was installed is invisible to that launcher.
// So the launcher carries a fingerprint of the registry it was built from, and anything holding the
// current registry can see that it is stale.
//
// It is READ out of the file, never asked for by running the launcher. That is the same rule that
// governs HARNESS_WRAPPER_VERSION and it exists because a pre-contract wrapper does not know `--check`
// and forwards it to the runtime: asking a launcher its version once meant launching Claude on a live
// machine.
//
// These tests supply a stub runtime rather than skipping when one is absent. A skipped assertion
// reports as a pass, and this suite has enough of those already.

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

const REGISTRY_ONE = {
  version: 1,
  services: {
    "aify-comms": {
      endpoint: "http://127.0.0.2:1",
      endpointEnv: ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"],
      mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }],
    },
  },
};

const REGISTRY_TWO = {
  version: 1,
  services: {
    ...REGISTRY_ONE.services,
    "aify-graph": {
      endpoint: "http://127.0.0.2:2",
      endpointEnv: ["AIFY_GRAPH_URL"],
      mcp: [{ name: "aify-graph", command: "node", args: ["/g/server.js"] }],
    },
  },
};

const winPath = (p) => (WIN
  ? execFileSync("bash", ["-c", `cygpath -w "${p.replace(/\\/g, "/")}"`], { encoding: "utf8" }).trim()
  : p);

/** Render one client with a given registry. `registry` may be an object, a raw string, or null. */
function renderWith(client, registry, { extraArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-fp-"));
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });

  const args = [INSTALL, "--client", client, "--endpoint", NOWHERE, "--render-only", out, ...extraArgs];
  if (registry !== null) {
    const file = path.join(dir, "services.json");
    fs.writeFileSync(file, typeof registry === "string" ? registry : JSON.stringify(registry));
    args.push("--registry", file);
  } else {
    // Point at a path that does not exist: "no registry on this host" is a legitimate state.
    args.push("--registry", path.join(dir, "absent.json"));
  }

  const res = spawnSync("bash", args, { encoding: "utf8", timeout: 120_000 });
  return { dir, out, res };
}

const fingerprintOf = (file) => {
  const m = /^HARNESS_REGISTRY_FINGERPRINT="([^"]*)"/m.exec(fs.readFileSync(file, "utf8"));
  return m ? m[1] : null;
};

test("the launcher carries the fingerprint of the registry it was built from", () => {
  const { dir, out, res } = renderWith("claude", REGISTRY_ONE);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const fp = fingerprintOf(path.join(out, "claude-aify"));
  assert.ok(fp && /^[0-9a-f]{8,}$/.test(fp), `expected a hex digest, got ${JSON.stringify(fp)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registering another service changes the fingerprint", () => {
  // The whole point: this is what lets anything holding the current registry see a launcher is stale.
  const a = renderWith("claude", REGISTRY_ONE);
  const b = renderWith("claude", REGISTRY_TWO);
  assert.notEqual(fingerprintOf(path.join(a.out, "claude-aify")), fingerprintOf(path.join(b.out, "claude-aify")));
  fs.rmSync(a.dir, { recursive: true, force: true });
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test("the same registry renders a BYTE-IDENTICAL launcher twice", () => {
  // Without this, every reinstall looks like a change to anything comparing launchers, and a real
  // change becomes impossible to see among the noise.
  const a = renderWith("claude", REGISTRY_ONE);
  const b = renderWith("claude", REGISTRY_ONE);
  assert.equal(
    fs.readFileSync(path.join(a.out, "claude-aify"), "utf8"),
    fs.readFileSync(path.join(b.out, "claude-aify"), "utf8"),
  );
  fs.rmSync(a.dir, { recursive: true, force: true });
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test("a host with NO registry still installs, carrying the empty-registry fingerprint", () => {
  const { dir, out, res } = renderWith("claude", null);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const fp = fingerprintOf(path.join(out, "claude-aify"));
  assert.ok(fp && fp.length > 0, "an absent registry must still produce a fingerprint, not a blank");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty-registry fingerprint DIFFERS from a populated one", () => {
  // Otherwise "no services" and "services" would be indistinguishable, and the staleness check that
  // matters most — the first service ever registered — would never fire.
  const none = renderWith("claude", null);
  const one = renderWith("claude", REGISTRY_ONE);
  assert.notEqual(fingerprintOf(path.join(none.out, "claude-aify")), fingerprintOf(path.join(one.out, "claude-aify")));
  fs.rmSync(none.dir, { recursive: true, force: true });
  fs.rmSync(one.dir, { recursive: true, force: true });
});

test("a MALFORMED registry refuses the install rather than building against a broken one", () => {
  // Guards fail closed. Installing anyway would produce a launcher pointing at whatever survived
  // parsing, which is the silent-partial-install failure with a different cause.
  const { dir, out, res } = renderWith("claude", "{not json");
  assert.notEqual(res.status, 0, "a malformed registry must not install");
  assert.match(`${res.stderr}${res.stdout}`, /registry/i);
  assert.deepEqual(fs.readdirSync(out), [], "nothing may be written when the registry is unreadable");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every client bakes the fingerprint, not just claude", () => {
  for (const client of ["claude", "codex", "hermes", "pi"]) {
    const { dir, out, res } = renderWith(client, REGISTRY_ONE);
    assert.equal(res.status, 0, `${client}: ${res.stderr}`);
    const name = client === "pi" ? "pi-aify" : `${client}-aify`;
    assert.ok(fingerprintOf(path.join(out, name)), `${client} launcher carries no fingerprint`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--check REPORTS the fingerprint, and still starts nothing", () => {
  // A stub runtime, so this runs everywhere instead of skipping on a machine without claude — and so
  // that "started nothing" is a claim about a launcher that actually reached its --check branch.
  const { dir, out, res } = renderWith("claude", REGISTRY_ONE);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);

  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  const marker = path.join(dir, "STARTED");
  fs.writeFileSync(path.join(stubs, "claude"), `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\nexit 0\n`);
  fs.chmodSync(path.join(stubs, "claude"), 0o755);

  const bashDir = winPath(execFileSync("bash", ["-c", 'dirname "$(command -v bash)"'], { encoding: "utf8" }).trim());
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });

  const run = spawnSync("bash", [path.join(out, "claude-aify"), "--check"], {
    encoding: "utf8",
    env: {
      PATH: [winPath(stubs), bashDir].join(WIN ? ";" : ":"),
      HOME: home.replace(/\\/g, "/"),
      HARNESS_IDENTITY: "probe-agent",
    },
    timeout: 60_000,
  });

  assert.equal(run.status, 0, `--check failed: ${run.stderr}`);
  assert.match(run.stdout, new RegExp(fingerprintOf(path.join(out, "claude-aify"))));
  assert.equal(fs.existsSync(marker), false, "--check started the runtime");
  fs.rmSync(dir, { recursive: true, force: true });
});
