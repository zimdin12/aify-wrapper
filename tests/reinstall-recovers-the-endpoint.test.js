// Updating means re-running the installer, and until now that meant remembering the endpoint you
// used the first time. `--endpoint` is required and the script refuses to guess -- correct for a
// FIRST install, where guessing an address is how an agent ends up talking to the wrong service.
//
// A reinstall is not a first install. The endpoint is already baked into the launcher sitting in
// --dest, so it can be read rather than asked for. Read, never executed: running a launcher to ask
// it something starts a runtime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { endpointInFile, endpointInstalledAt } from "../lib/installed-endpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const KNOWN = "http://10.11.12.13:8800";

const posix = (p) => p.split(String.fromCharCode(92)).join("/");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-reinstall-"));
}

function install(dest, args) {
  return spawnSync("bash", [INSTALL, "--client", "claude", "--dest", posix(dest), ...args], {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, AIFY_NO_PROMPT: "1" },
  });
}

test("reads the endpoint back out of an installed launcher", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);
  assert.equal(endpointInstalledAt(dest), KNOWN);
});

test("an empty destination has no endpoint to recover, and says so as null", () => {
  assert.equal(endpointInstalledAt(tmp()), null);
  assert.equal(endpointInstalledAt(path.join(tmp(), "does-not-exist")), null);
});

test("a template is not an installed launcher", () => {
  // The placeholder must never come back as if it were an address: bake it and the next launcher
  // carries the literal text `@@ENDPOINT@@` where a URL belongs.
  const template = path.join(ROOT, "wrappers", "claude-aify.sh.in");
  assert.equal(endpointInFile(template), null);

  const dest = tmp();
  fs.copyFileSync(template, path.join(dest, "claude-aify"));
  assert.equal(endpointInstalledAt(dest), null);
});

test("a single file answers for itself, and absence is null rather than a throw", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);
  assert.equal(endpointInFile(path.join(dest, "claude-aify")), KNOWN);

  assert.equal(endpointInFile(path.join(dest, "codex-aify")), null, "not installed here");
  assert.equal(endpointInFile(dest), null, "a directory is not a launcher");
  fs.writeFileSync(path.join(dest, "empty-aify"), "");
  assert.equal(endpointInFile(path.join(dest, "empty-aify")), null, "no marker, no answer");
});

test("reinstalling without --endpoint keeps the endpoint that was already there", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);

  const again = install(dest, []);
  assert.equal(again.status, 0, `reinstall should succeed: ${again.stdout}\n${again.stderr}`);
  assert.match(again.stderr + again.stdout, /10\.11\.12\.13/,
    "it must say which endpoint it reused rather than reusing one silently");
  assert.equal(endpointInstalledAt(dest), KNOWN);
});

test("a FIRST install with no endpoint is still refused", () => {
  const first = install(tmp(), []);
  assert.equal(first.status, 78, "nothing installed there, so there is nothing to recover");
  assert.match(first.stderr, /--endpoint is required/);
});

test("an explicit --endpoint still wins over what is installed", () => {
  const dest = tmp();
  assert.equal(install(dest, ["--endpoint", KNOWN]).status, 0);
  assert.equal(install(dest, ["--endpoint", "http://127.0.0.2:1"]).status, 0);
  assert.equal(endpointInstalledAt(dest), "http://127.0.0.2:1");
});

// hermes nests the fallback TWICE, because it tries a second variable before the baked default:
//   HARNESS_ENDPOINT="${HARNESS_ENDPOINT-${AIFY_SERVER_URL:-${AIFY_COMMS_URL:-<url>}}}"
// A pattern written against claude's single level matched nothing for it. aify-comms' redeploy falls
// back to loopback when nothing is recovered, so a hermes-only host would have had every wrapper
// repointed at 127.0.0.1 by the command that exists to preserve its endpoint. Found in pre-deploy
// review while every test here was green -- because every test here rendered claude.
test("the endpoint is read at any nesting depth, not just claude's", () => {
  const NL = String.fromCharCode(10);
  const Q = String.fromCharCode(34);
  const line = (body) => "#!/bin/bash" + NL + "HARNESS_ENDPOINT=" + Q + body + Q + NL;

  const one = line("${HARNESS_ENDPOINT-${AIFY_COMMS_URL:-http://10.1.1.1:8800}}");
  const two = line("${HARNESS_ENDPOINT-${AIFY_SERVER_URL:-${AIFY_COMMS_URL:-http://10.2.2.2:8800}}}");
  const three = line("${HARNESS_ENDPOINT-${A:-${B:-${C:-http://10.3.3.3:8800}}}}");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-depth-"));
  const at = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  assert.equal(endpointInFile(at("a-aify", one)), "http://10.1.1.1:8800");
  assert.equal(endpointInFile(at("b-aify", two)), "http://10.2.2.2:8800");
  assert.equal(endpointInFile(at("c-aify", three)), "http://10.3.3.3:8800");

  // Still no answer where there is none to give.
  assert.equal(endpointInFile(at("d-aify", line("${HARNESS_ENDPOINT-${X:-@@ENDPOINT@@}}"))), null);
  assert.equal(endpointInFile(at("e-aify", "#!/bin/bash" + NL)), null);
});
