#!/usr/bin/env node
// Strict mode, and the one thing it must keep being.
//
// `AIFY_CLAUDE_STRICT_MCP=1` narrows a Claude session to the servers needed for channel wake. It
// exists BECAUSE extra MCP servers cause the Claude Code init race (#38462, #21341) that leaves
// aify-comms-channel stuck in "still connecting" and stops notifications arriving.
//
// So the multi-service answer here is opt-in, never automatic. A host that opted nothing in must get
// the config it gets today, unchanged — that is the first test below, and it is the one that would
// catch this feature quietly becoming a regression for everybody who never asked for it.
//
// These tests run the launcher with a stub `claude` that copies the config it was handed, so the
// assertion is about what Claude would actually have received rather than about what the template
// looks like.

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
const SEP = WIN ? ";" : ":";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

const winPath = (p) => (WIN
  ? execFileSync("bash", ["-c", `cygpath -w "${posix(p)}"`], { encoding: "utf8" }).trim()
  : p);

const bashDir = () => winPath(
  execFileSync("bash", ["-c", 'dirname "$(command -v bash)"'], { encoding: "utf8" }).trim(),
);

const WITHOUT_OPT_IN = {
  version: 1,
  services: {
    "aify-comms": {
      endpoint: NOWHERE,
      endpointEnv: ["AIFY_SERVER_URL", "CLAUDE_MCP_SERVER_URL"],
      mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }],
    },
  },
};

const WITH_OPT_IN = {
  version: 1,
  services: {
    ...WITHOUT_OPT_IN.services,
    "aify-graph": {
      endpoint: "http://127.0.0.2:2",
      endpointEnv: ["AIFY_GRAPH_URL"],
      strictMcp: true,
      mcp: [{ name: "aify-graph", command: "node", args: ["/g/graph.js"] }],
    },
  },
};

/**
 * Render claude against a registry, then run it in strict mode with a stub runtime that captures the
 * MCP config, and return the parsed config.
 */
function strictConfigFor(registry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-strict-"));
  const out = path.join(dir, "out");
  const stubs = path.join(dir, "stubs");
  const home = path.join(dir, "home");
  const captured = path.join(dir, "captured.json");
  for (const d of [out, stubs, home]) fs.mkdirSync(d, { recursive: true });

  const registryFile = path.join(dir, "services.json");
  fs.writeFileSync(registryFile, JSON.stringify(registry));

  const rendered = spawnSync("bash", [
    INSTALL, "--client", "claude", "--endpoint", NOWHERE,
    "--render-only", out, "--registry", registryFile,
  ], { encoding: "utf8", timeout: 120_000 });
  assert.equal(rendered.status, 0, `render failed: ${rendered.stdout}\n${rendered.stderr}`);

  // A stub that copies whatever --mcp-config it was given, then exits. This is what makes the
  // assertion about Claude's actual input rather than about the launcher's source.
  fs.writeFileSync(path.join(stubs, "claude"), [
    "#!/bin/sh",
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "--mcp-config" ]; then cp "$2" "' + posix(captured) + '"; fi',
    "  shift",
    "done",
    "exit 0",
    "",
  ].join(String.fromCharCode(10)));
  fs.chmodSync(path.join(stubs, "claude"), 0o755);

  const run = spawnSync("bash", [path.join(out, "claude-aify")], {
    encoding: "utf8",
    env: {
      PATH: [winPath(stubs), bashDir()].join(SEP),
      HOME: posix(home),
      AIFY_CLAUDE_STRICT_MCP: "1",
      HARNESS_IDENTITY: "probe-agent",
    },
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `launcher failed: ${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(captured), `no --mcp-config was passed:\n${run.stdout}\n${run.stderr}`);

  const config = JSON.parse(fs.readFileSync(captured, "utf8"));
  return { config, dir };
}

test("a host that opted NOTHING in gets exactly the two servers it gets today", () => {
  const { config, dir } = strictConfigFor(WITHOUT_OPT_IN);
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["aify-comms", "aify-comms-channel"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an opted-in service is carried, with ITS endpoint in ITS declared env names", () => {
  const { config, dir } = strictConfigFor(WITH_OPT_IN);
  assert.deepEqual(
    Object.keys(config.mcpServers).sort(),
    ["aify-comms", "aify-comms-channel", "aify-graph"],
  );
  // Not the comms endpoint, and not under the comms env names: the per-server block is key-scoped,
  // so a service reading a name nobody set for it would inherit one instead.
  assert.deepEqual(config.mcpServers["aify-graph"].env, { AIFY_GRAPH_URL: "http://127.0.0.2:2" });
  assert.equal(config.mcpServers["aify-graph"].args[0], "/g/graph.js");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the comms pair still resolves its endpoint at LAUNCH, not from the registry", () => {
  // HARNESS_ENDPOINT is a launch-time input and has to keep winning for the primary pair. Baking the
  // registry's value for them would mean a session announcing one endpoint while its bridge used
  // another — a bug this project has already fixed once.
  const { config, dir } = strictConfigFor(WITH_OPT_IN);
  for (const name of ["aify-comms", "aify-comms-channel"]) {
    assert.equal(config.mcpServers[name].env.AIFY_SERVER_URL, NOWHERE);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the emitted config is valid JSON even when an opted-in path is hostile", () => {
  // The heredoc that writes this is unquoted, so a backslash, a dollar or a backtick in a path is a
  // live hazard. This is the end-to-end version of the unit test on the fragment.
  const B = String.fromCharCode(92);
  const TICK = String.fromCharCode(96);
  const nasty = `C:${B}bin${B}$HOME${B}${TICK}whoami${TICK}${B}graph.js`;
  const { config, dir } = strictConfigFor({
    version: 1,
    services: {
      ...WITHOUT_OPT_IN.services,
      "aify-graph": {
        endpoint: "http://127.0.0.2:2",
        strictMcp: true,
        mcp: [{ name: "aify-graph", command: "node", args: [nasty] }],
      },
    },
  });
  assert.equal(config.mcpServers["aify-graph"].args[0], nasty);
  fs.rmSync(dir, { recursive: true, force: true });
});
