#!/usr/bin/env node
// lib/machine-id.mjs (machineIdFor, hostIsWsl) and lib/credential-file.mjs (credentialFromBytes, readCredential) are
// copies of aify-env's rules, so each is driven against aify-env's own functions over the same inputs. A machine id that
// differs places an agent in no project, silently; a key decoded differently is a key the service never issued.
//
// THE SIBLING CHECKOUT: `AIFY_ENV_REPO`, else beside this checkout, else ~/projects/aify-env. With none, this SKIPS
// BY NAME: a cross-repo proof that ran nothing must not read as a pass. aify-env's modules are imported in a child,
// as tests/the-definition-schema-is-aify-envs.test.js does; both are pure, so nothing runs a daemon.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { credentialFromBytes, readCredential } from "../lib/credential-file.mjs";
import { hostIsWsl, machineIdFor } from "../lib/machine-id.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEEDED = ["lib/advertise.mjs", "lib/host-wsl.mjs", "lib/credential-store.mjs"];
const CANDIDATES = [process.env.AIFY_ENV_REPO, path.join(ROOT, "..", "aify-env"), path.join(os.homedir(), "projects", "aify-env")].filter(Boolean);
const ENV_REPO = CANDIDATES.find((dir) => NEEDED.every((file) => fs.existsSync(path.join(dir, file))));
const skip = ENV_REPO ? false : `no aify-env checkout with ${NEEDED.join(", ")} (looked in ${CANDIDATES.join(", ")}): NOT verified`;

/** Run `body` in a child that has aify-env's module `name` imported as `env`; returns its JSON stdout. */
function inEnv(name, body, input) {
  const href = pathToFileURL(path.join(ENV_REPO, "lib", name)).href;
  const script = `const env = await import(${JSON.stringify(href)}); const input = JSON.parse(process.argv[1]); ${body}`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input)], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const HOSTS = [
  { platform: "win32", hostname: "os-name", env: { COMPUTERNAME: "StevenZ-L" } },
  { platform: "win32", hostname: "os-name", env: { AIFY_MACHINE_ID: "Chosen", COMPUTERNAME: "StevenZ-L" } },
  { platform: "win32", hostname: "os-name", env: { AIFY_MACHINE_ID: "", COMPUTERNAME: "" , HOSTNAME: "" } },
  { platform: "win32", hostname: "", env: {} },
  { platform: "linux", hostname: "box", env: { HOSTNAME: "  Spaced-Host  " }, isWsl: true },
  { platform: "linux", hostname: "box", env: { HOSTNAME: "Linux-Host" }, isWsl: false },
  { platform: "linux", hostname: "   ", env: {}, isWsl: true },
  { platform: "darwin", hostname: "Mac.local", env: {} },
  { platform: "", hostname: "x", env: { COMPUTERNAME: "Y" } },
];

test("THE MACHINE ID is aify-env's for every host spelling", { skip }, () => {
  const theirs = inEnv("advertise.mjs", "process.stdout.write(JSON.stringify(input.map((facts) => env.machineIdFor(facts))));", HOSTS);
  assert.deepEqual(HOSTS.map((facts) => machineIdFor(facts)), theirs);
  assert.ok(theirs.includes("win32:stevenz-l"), "control: the mixed-case host was lower-cased by both");
});

test("WSL is aify-env's answer for every osrelease, including an unreadable one", { skip }, () => {
  const releases = [
    ["linux", "5.15.167.4-microsoft-standard-WSL2"], ["linux", "4.4.0-19041-Microsoft"], ["linux", "6.8.0-45-generic"],
    ["linux", null], ["win32", "microsoft"], ["darwin", "WSL"],
  ];
  const theirs = inEnv("host-wsl.mjs", `process.stdout.write(JSON.stringify(input.map(([platform, release]) => env.hostIsWsl({ platform,
    readFile: () => { if (release === null) throw new Error("unreadable"); return release; } }))));`, releases);
  const ours = releases.map(([platform, release]) => hostIsWsl({ platform,
    readFile: () => { if (release === null) throw new Error("unreadable"); return release; } }));
  assert.deepEqual(ours, theirs);
  assert.deepEqual(theirs, [true, true, false, false, false, false], "control: both a yes and a no were exercised");
});

test("THE CREDENTIAL is aify-env's decoding for every byte shape it refuses or accepts", { skip }, () => {
  const shapes = [
    "key-1\n", "key-1", "key-1\n\n", "key-1\r\n", " key-1\n", "key-1 \n", "\n", "", "ke\ty\n", "ke\u0000y\n",
    `${"k".repeat(4095)}\n`, `${"k".repeat(4096)}\n`, "kéy\n",
  ].map((text) => Buffer.from(text, "utf8").toString("base64"));
  shapes.push(Buffer.from([0xff, 0xfe, 0x0a]).toString("base64"));
  const theirs = inEnv("credential-store.mjs", `process.stdout.write(JSON.stringify(input.map((b64) => {
    const decoded = env.decodeCredential(Buffer.from(b64, "base64"));
    return decoded.state === env.CREDENTIAL_OK ? decoded.value : ""; })));`, shapes);
  assert.deepEqual(shapes.map((b64) => credentialFromBytes(Buffer.from(b64, "base64"))), theirs);
  assert.ok(theirs.includes("key-1") && theirs.includes(""), "control: both an accepted and a refused shape");
});

test("readCredential reads ~/.aify/credentials/<ref> under the home it is given, and gives nothing for a missing file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-credential-file-"));
  try {
    fs.mkdirSync(path.join(home, ".aify", "credentials"), { recursive: true });
    fs.writeFileSync(path.join(home, ".aify", "credentials", "svc.key"), "the-key\n");
    assert.equal(readCredential("svc.key", { home }), "the-key");
    assert.equal(readCredential("absent.key", { home }), "");
    assert.equal(readCredential("", { home }), "");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
