#!/usr/bin/env node
// npm for connect's tests: the REAL npm (AIFY_TEST_REAL_NPM, resolved by the test before it sealed anything), with
// one change of transport. `github:<owner>/<name>#<sha>` becomes `git+file:///<AIFY_TEST_GIT_ROOT>/<owner>/<name>.git#<sha>`,
// a bare repository the test built, so no test reaches github or the operator's private repository. Every other
// argument, the scripts setting among them, reaches npm unchanged.
//
// Every call is appended to AIFY_TEST_NPM_SPY as one JSON line of argv, before the rewrite.
// AIFY_TEST_NPM_REVISION=<sha> installs that commit instead of the one asked for: npm doing something other than
// what connect asked, which connect must catch by reading back what was installed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (process.env.AIFY_TEST_NPM_SPY) fs.appendFileSync(process.env.AIFY_TEST_NPM_SPY, `${JSON.stringify(args)}\n`);

// Any github spec is mapped, whatever its committish, so no mutation of connect can make a test reach the network;
// any other remote spec is refused outright.
const rewritten = args.map((arg) => {
  const github = /^github:([^#]+)#(.*)$/.exec(arg);
  if (!github) return arg;
  const root = String(process.env.AIFY_TEST_GIT_ROOT).replace(/\\/g, "/");
  return `git+file:///${root.replace(/^\//, "")}/${github[1]}.git#${process.env.AIFY_TEST_NPM_REVISION || github[2]}`;
});
const remote = rewritten.find((arg) => /^(github:|gitlab:|bitbucket:|git\+(?!file:)|git:|https?:|ssh:)/.test(arg));
if (remote || !process.env.AIFY_TEST_GIT_ROOT && args.some((arg) => arg.startsWith("github:"))) {
  process.stderr.write(`fake-npm: refuses ${remote ?? "a github spec with no AIFY_TEST_GIT_ROOT"}; tests never reach the network\n`);
  process.exit(1);
}
const run = spawnSync(process.execPath, [process.env.AIFY_TEST_REAL_NPM, ...rewritten], { env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
process.exit(run.status ?? 1);
