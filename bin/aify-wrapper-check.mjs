#!/usr/bin/env node
// Are the launchers on this host still built from the registry this host has?
//
//   aify-wrapper-check              human-readable
//   aify-wrapper-check --json       {ok, summary, current, stale, unknown}
//   aify-wrapper-check --strict     exit 1 when anything is stale OR unreadable
//   aify-wrapper-check --dest <dir> --registry <path>
//
// IT READS. Every launcher is judged from its text and none is executed. A launcher does not know
// `--check` unless it was built with the contract, so asking one about itself would forward the flag to
// the runtime and START it — which is how a four-second probe once superseded a live environment bridge
// and reaped a managed fleet.
//
// This is the reader the baked fingerprint never had. Without it the value was written into every
// launcher, printed by `--check`, and compared to nothing.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseRegistry, fingerprint } from "../lib/registry.mjs";
import { stalenessOf } from "../lib/staleness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const DEST = flag("--dest", join(homedir(), ".local", "bin"));
const REGISTRY = flag("--registry", join(homedir(), ".aify", "services.json"));
const asJson = args.includes("--json");
const strict = args.includes("--strict");

/** `<something>-aify`, which is the shape every launcher this package installs has. */
const LAUNCHER = /-aify(\.[a-z0-9]+)?$/i;

let launchers = [];
try {
  launchers = readdirSync(DEST)
    .filter((name) => LAUNCHER.test(name))
    // Windows shims are a couple of lines of batch that call the real launcher; they carry no
    // fingerprint and are not the thing being judged.
    .filter((name) => !/\.(cmd|ps1)$/i.test(name))
    .map((name) => {
      try {
        return { name, text: readFileSync(join(DEST, name), "utf8") };
      } catch {
        // Unreadable is not absent: it lands in `unknown` rather than vanishing from the count.
        return { name, text: null };
      }
    });
} catch (error) {
  process.stderr.write(`cannot read ${DEST}: ${error.code ?? error.message}\n`);
  process.exit(strict ? 1 : 0);
}

let registryText = "";
try {
  registryText = readFileSync(REGISTRY, "utf8");
} catch {
  // Absent is a legitimate host state; it fingerprints as the empty registry below.
}

const parsed = parseRegistry(registryText);
if (!parsed.ok) {
  process.stderr.write(`registry ${REGISTRY} is not usable:\n`);
  for (const problem of parsed.errors) process.stderr.write(`  - ${problem}\n`);
  // Refuse rather than compare against a guess: every launcher would read stale, which is a lie about
  // the launchers and hides the real problem, which is the registry.
  process.exit(strict ? 1 : 0);
}

const result = stalenessOf({ launchers, registryFingerprint: fingerprint(parsed.registry) });

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const row of result.current) process.stdout.write(`  ok    ${row.name}\n`);
  for (const row of result.stale) {
    process.stdout.write(`  STALE ${row.name}  built from ${row.installed}, registry is ${row.expected}\n`);
  }
  for (const row of result.unknown) {
    process.stdout.write(`  ??    ${row.name}  no registry fingerprint — installed before this existed?\n`);
  }
  process.stdout.write(`\n${result.summary}\n`);
}

process.exit(strict && !result.ok ? 1 : 0);
