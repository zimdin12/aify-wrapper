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

// `registry check [--service <name>] <file>`, the interface of aify-env 3b3913a, with the `--service` scope the operator
// decided: JSON `{check, ok, references, problems, warnings}` on stdout, exit 0 ok, 65 problems, 64 usage. With
// --service, only that service's references must exist in the store; another service's missing one is a warning.
// AIFY_TEST_REAL_REGISTRY=<aify-env-registry.mjs> runs the real check instead, for a recorded real-binary run.
if (args[0] === "registry") {
  if (process.env.AIFY_TEST_REAL_REGISTRY) {
    const run = spawnSync(process.execPath, [process.env.AIFY_TEST_REAL_REGISTRY, ...args.slice(1)], { env: process.env });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exit(run.status ?? 65);
  }
  const at = args.indexOf("--service");
  const joined = args.find((a) => a.startsWith("--service="));
  const service = joined ? joined.slice(10) : at === -1 ? "" : args[at + 1];
  const file = args.filter((a, i) => i > 1 && a !== "--service" && a !== joined && i !== at + 1)[0];
  if (args[1] !== "check" || !file || (at !== -1 && !service)) {
    process.stderr.write("aify-env registry: usage: registry check [--service <name>] <file>\n");
    process.exit(64);
  }
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  const owners = new Map();
  const problems = [];
  // 3b3913a: a --service the candidate does not hold is refused, so a typo cannot turn every store fault into a warning.
  if (service && !Object.hasOwn(registry.services ?? {}, service)) {
    problems.push({ code: "service-absent", service, field: null, detail: "the candidate holds no entry by this name" });
  }
  const warnings = [];
  const references = [];
  for (const [name, entry] of Object.entries(registry.services ?? {})) {
    const refs = Object.entries(entry).filter(([key]) => REF.test(key));
    if (entry.agentState?.credentialRef) refs.push(["agentState.credentialRef", entry.agentState.credentialRef]);
    for (const [field, ref] of refs) {
      if (refProblem(ref)) { problems.push({ code: "credential-ref", service: name, field, detail: `${JSON.stringify(ref)} is ${refProblem(ref)}` }); continue; }
      const owner = owners.get(String(ref).toLowerCase());
      if (owner && owner !== name) problems.push({ code: "credential-ref-collision", service: name, field, detail: `'${String(ref).toLowerCase()}' is also ${owner}'s credential file, so the two services would share one key` });
      owners.set(String(ref).toLowerCase(), name);
      const present = fs.existsSync(path.join(os.homedir(), ".aify", "credentials", ref));
      references.push({ service: name, field, ref, store: present ? "CREDENTIAL_OK" : "CREDENTIAL_MISSING" });
      if (present) continue;
      const missing = { code: "credential-store", service: name, field, detail: "CREDENTIAL_MISSING: the registry names a credential file that does not exist" };
      (service && name !== service ? warnings : problems).push(missing);
    }
    if (entry.advertise !== undefined && typeof entry.advertise !== "boolean") problems.push({ code: "advertise", service: name, field: "advertise", detail: "is not true or false" });
  }
  process.stdout.write(`${JSON.stringify({ check: 1, ok: problems.length === 0, references, problems, warnings }, null, 2)}\n`);
  process.exit(problems.length ? 65 : 0);
}

process.stderr.write(`fake-aify-env: no such command ${args.join(" ")}\n`);
process.exit(64);
