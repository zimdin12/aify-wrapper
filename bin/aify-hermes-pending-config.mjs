#!/usr/bin/env node
// The hermes config change an install leaves pending (lib/hermes-pending-config.mjs).
//
//   aify-hermes-pending-config record --marker <file> --registry <file>   install.sh: record the change
//   aify-hermes-pending-config apply --marker <file>                      install.sh and hermes-aify: apply it if no hermes runs
//
// `apply` exits 0 when it applied the change or none was pending, 75 when it waits for a quiet host, 78 when the step
// failed; what it did goes to stderr, because a launcher's stdout is its runtime's. The step is lib/hermes-config-cli.mjs
// with this environment, so HERMES_RUNTIME_COMMAND chooses the hermes it runs, as it does for the installer.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { FileLockBusyError } from "../lib/file-lock.mjs";
import { hermesConfigTarget, OUTCOMES, PendingHermesConfig } from "../lib/hermes-pending-config.mjs";
import { isMainModule } from "../lib/main-module.mjs";
import { processTable } from "../lib/process-identity.mjs";

const STEP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "hermes-config-cli.mjs");
//: The whole step, bounded inside the lock it holds (lib/hermes-pending-config.mjs).
const STEP_TIMEOUT_MS = 10 * 60_000;

/** The installer's hermes step, its output on this process's stderr. */
function step(registry) {
  const run = spawnSync(process.execPath, [STEP, registry], { stdio: ["ignore", 2, 2], timeout: STEP_TIMEOUT_MS });
  if (run.error) return { ok: false, detail: `the hermes config step did not finish (${run.error.code ?? run.error.message})` };
  return run.status === 0 ? { ok: true, detail: "" } : { ok: false, detail: `the hermes config step exited ${run.status}, its reason above` };
}

if (isMainModule(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { marker: { type: "string" }, registry: { type: "string" } } });
  const [verb] = positionals;
  if (!values.marker || !["record", "apply"].includes(verb) || (verb === "record" && !values.registry)) {
    process.stderr.write("usage: aify-hermes-pending-config record --marker <file> --registry <file> | apply --marker <file>\n");
    process.exit(OUTCOMES.failed);
  }
  const pending = new PendingHermesConfig({ marker: values.marker });
  // The config this process's hermes would write, from its own environment: the installer's and the launcher's.
  const target = hermesConfigTarget({ env: process.env, platform: process.platform, homedir: homedir() });
  if (verb === "record") {
    if (target === null) {
      process.stderr.write(`hermes config: HERMES_HOME (${process.env.HERMES_HOME}) holds ~ or variable syntax that hermes expands and this does not; set it to a plain path, then re-run\n`);
      process.exit(OUTCOMES.failed);
    }
    try {
      pending.record(values.registry, target);
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) throw error;
      process.stderr.write(`hermes config: a hermes start is applying an earlier change and still holds ${pending.lock.path}; re-run the installer when it is done\n`);
      process.exit(OUTCOMES.failed);
    }
  } else {
    const { outcome, detail } = pending.apply({ scan: () => processTable({ commands: true }), step, target });
    if (outcome !== "none") process.stderr.write(`hermes config: ${detail}\n`);
    process.exitCode = OUTCOMES[outcome];
  }
}
