#!/usr/bin/env node
// A stand-in for `aify-env.mjs`, for the two commands connect calls: `credential set|remove` and `registry check`.
//
// THE CREDENTIAL HALF IS THE REAL ONE when it can be: aify-env's own bin/aify-env-credential.mjs from the sibling
// checkout named by AIFY_ENV_REPO (resolved by the test before it seals HOME), run under that sealed HOME. Only
// without that checkout does it fall back to writing the store's file format itself.
//
// THE CHECK HALF FAILS THE WAY THE REAL ONE IS SPECIFIED TO: exit 65 with the problem on stderr, for a reference
// outside the store's grammar or one that two services claim in any spelling (guided-install S1, "Fields the parser
// ignores"). The real `aify-env registry check` is being built beside this; runs against it are recorded apart.
//
// Every call is appended to AIFY_TEST_SPY as one JSON line of argv. Never a value: stdin is not logged.
// AIFY_TEST_FAIL=<word> makes the matching command fail as the real one does, with exit 65.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.AIFY_TEST_SPY) fs.appendFileSync(process.env.AIFY_TEST_SPY, `${JSON.stringify(args)}\n`);
const fail = (process.env.AIFY_TEST_FAIL || "").split(",");
const word = args.slice(0, 2).join("-");
if (fail.includes(word)) {
  process.stderr.write(`aify-env ${args.slice(0, 2).join(" ")}: failed as asked by the test\n`);
  process.exit(65);
}

const REF = /^(?:c|[a-z][A-Za-z0-9]*C)redentialRef$/;
const refProblem = (ref) => (typeof ref !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(ref) || ref.startsWith(".") ? "not a credential basename" : "");

if (args[0] === "credential") {
  // The test resolves the checkout before it seals HOME, and passes it here; a sealed HOME points nowhere useful.
  const repo = [process.env.AIFY_ENV_REPO]
    .filter(Boolean).map((dir) => path.join(dir, "bin", "aify-env-credential.mjs")).find((file) => fs.existsSync(file));
  if (repo && process.env.AIFY_TEST_REAL_CREDENTIAL !== "0") {
    const run = spawnSync(process.execPath, [repo, ...args.slice(1)], { input: fs.readFileSync(0), env: process.env });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exit(run.status ?? 65);
  }
  const ref = (args.find((a) => a.startsWith("--ref=")) || "").slice(6);
  const file = path.join(os.homedir(), ".aify", "credentials", ref);
  if (args[1] === "set") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fs.readFileSync(0), { mode: 0o600 });
  } else if (args[1] === "remove") {
    fs.rmSync(file, { force: true });
  }
  process.stdout.write(`${ref}\n`);
  process.exit(0);
}

if (args[0] === "registry" && args[1] === "check") {
  const registry = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const owners = new Map();
  const problems = [];
  for (const [name, entry] of Object.entries(registry.services ?? {})) {
    const refs = Object.entries(entry).filter(([key]) => REF.test(key)).map(([, value]) => value);
    if (entry.agentState?.credentialRef) refs.push(entry.agentState.credentialRef);
    for (const ref of refs) {
      if (refProblem(ref)) problems.push(`${name}: ${JSON.stringify(ref)} is ${refProblem(ref)}`);
      const owner = owners.get(String(ref).toLowerCase());
      if (owner && owner !== name) problems.push(`${JSON.stringify(ref)} is claimed by both ${owner} and ${name}`);
      owners.set(String(ref).toLowerCase(), name);
    }
    if (entry.advertise !== undefined && typeof entry.advertise !== "boolean") problems.push(`${name}.advertise is not true or false`);
  }
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(65);
  }
  process.exit(0);
}

process.stderr.write(`fake-aify-env: no such command ${args.join(" ")}\n`);
process.exit(64);
