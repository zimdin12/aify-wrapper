#!/usr/bin/env node
// Are this host's launchers consistent with its registry and their owning template packages?
//
//   aify-wrapper-check              human-readable
//   aify-wrapper-check --json       {ok, summary, current, stale, unknown}, plus errors when it refuses
//   aify-wrapper-check --strict     exit 1 for stale, unknown or refused launcher judgments
//   aify-wrapper-check --dest <dir> --registry <path> --pending <path>
//
// It also says whether an install left a hermes config change PENDING (lib/hermes-pending-config.mjs), which the
// first hermes start that finds no hermes running applies: `hermesConfigPending` under --json, null when none is.
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

import { PendingHermesConfig, pendingMarkerPath } from "../lib/hermes-pending-config.mjs";
import { parseRegistry, fingerprint } from "../lib/registry.mjs";
import { stalenessOf } from "../lib/staleness.mjs";
import { LauncherProvenanceReader } from "../lib/launcher-provenance.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const DEST = flag("--dest", join(homedir(), ".local", "bin"));
const REGISTRY = flag("--registry", join(homedir(), ".aify", "services.json"));
const PENDING = flag("--pending", pendingMarkerPath(homedir()));
const asJson = args.includes("--json");
const strict = args.includes("--strict");

/**
 * A refusal to judge, and why: said on stderr here, and returned as the report, so under --json the reader
 * gets an answer rather than an empty stdout it cannot tell from a crash.
 */
function refusal(summary, errors = []) {
  process.stderr.write(`${summary}${errors.length ? ":" : ""}\n`);
  for (const problem of errors) process.stderr.write(`  - ${problem}\n`);
  return { refused: true, report: { ok: false, current: [], stale: [], unknown: [], summary, errors } };
}

/** `<something>-aify`, which is the shape every launcher this package installs has. */
const LAUNCHER = /-aify(\.[a-z0-9]+)?$/i;

function judge() {
  let launchers = [];
  try {
    launchers = readdirSync(DEST)
      .filter((name) => LAUNCHER.test(name))
      // Windows shims are a couple of lines of batch that call the real launcher; they carry no
      // fingerprint and are not the thing being judged.
      .filter((name) => !/\.(cmd|ps1)$/i.test(name))
      .map((name) => {
        try {
          const bytes = readFileSync(join(DEST, name));
          return { name, path: join(DEST, name), bytes, text: bytes.toString("utf8") };
        } catch {
          // Unreadable is not absent: it lands in `unknown` rather than vanishing from the count.
          return { name, path: join(DEST, name), text: null };
        }
      });
  } catch (error) {
    return refusal(`cannot read ${DEST}: ${error.code ?? error.message}`);
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
    return refusal(`registry ${REGISTRY} is not usable`, parsed.errors);
  }
  const reader = new LauncherProvenanceReader({ registryPath: REGISTRY });
  const provenance = new Map(launchers.map(launcher => [launcher.name, reader.read(launcher)]));
  return { refused: false, report: stalenessOf({ launchers, registryFingerprint: fingerprint(parsed.registry), provenance }) };
}

function reasonText(reason) {
  const values = reason.installed !== null && reason.expected !== null
    ? ` (built from ${reason.installed}, expected ${reason.expected})` : "";
  return `${reason.detail}${values}${reason.remedy ? `; ${reason.remedy}` : ""}`;
}

const { refused, report } = judge();
const pending = new PendingHermesConfig({ marker: PENDING }).read();
report.hermesConfigPending = pending.state === "none" ? null
  : pending.state === "pending" ? { recordedAt: pending.recordedAt, registry: pending.registry, target: pending.target } : { problem: pending.problem };

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (!refused) {
  for (const row of report.current) process.stdout.write(`  ok    ${row.name}\n`);
  for (const row of report.stale) {
    process.stdout.write(`  STALE ${row.name}  ${row.reasons.filter(reason => reason.state !== "current").map(reasonText).join("; ")}\n`);
  }
  for (const row of report.unknown) {
    process.stdout.write(`  ??    ${row.name}  ${row.reasons.filter(reason => reason.state === "unknown").map(reasonText).join("; ")}\n`);
  }
  process.stdout.write(`\n${report.summary}\n`);
}
if (!asJson && pending.state === "pending") {
  process.stdout.write(`hermes config pending since ${pending.recordedAt} for ${pending.target}: the first hermes start of that config that finds no hermes running applies it\n`);
} else if (!asJson && pending.state === "unreadable") {
  process.stdout.write(`hermes config pending, unreadable: ${pending.problem}\n`);
}

// An exit CODE, never process.exit(): stdout to a pipe is asynchronous on POSIX, and exiting at once cuts
// off a report still queued (review of 87cf786). Node exits when the writes are done.
process.exitCode = strict && !report.ok ? 1 : 0;
