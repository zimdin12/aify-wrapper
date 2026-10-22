#!/usr/bin/env node
// Are the launchers on this host still built from the registry this host has?
//
//   aify-wrapper-check              human-readable
//   aify-wrapper-check --json       {ok, summary, current, stale, unknown}, plus errors when it refuses
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

/**
 * Refuse to judge, and say why: on stderr, and under --json also as the report on stdout, so a JSON reader
 * gets an answer rather than an empty stdout it cannot tell from a crash. Only --strict exits 1.
 */
function refuse(summary, errors = []) {
  process.stderr.write(`${summary}${errors.length ? ":" : ""}\n`);
  for (const problem of errors) process.stderr.write(`  - ${problem}\n`);
  if (asJson) {
    const report = { ok: false, current: [], stale: [], unknown: [], summary, errors };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  process.exit(strict ? 1 : 0);
}

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
  refuse(`cannot read ${DEST}: ${error.code ?? error.message}`);
}

let registryText = "";
try {
  registryText = readFileSync(REGISTRY, "utf8");
} catch {
  // Absent is a legitimate host state; it fingerprints as the empty registry below.
}

const parsed = parseRegistry(registryText);
if (!parsed.ok) {
  // Refuse rather than compare against a guess: every launcher would read stale, which is a lie about
  // the launchers and hides the real problem, which is the registry.
  refuse(`registry ${REGISTRY} is not usable`, parsed.errors);
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
