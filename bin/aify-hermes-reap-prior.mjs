#!/usr/bin/env node
// End what the previous hermes launch for an agent left running (lib/hermes-prior-runs.mjs).
//
//   aify-hermes-reap-prior --agent <id> [--exclude <pid>] [--resume-id <session id>]
//
// `--exclude` is this launch's own delivery loop, a Windows pid on Windows. Always exits 0: kill-prior is
// best-effort and never stops a launch.

import process from "node:process";
import { parseArgs } from "node:util";

import { reapPriorHermesRuns } from "../lib/hermes-prior-runs.mjs";
import { isMainModule } from "../lib/main-module.mjs";

if (isMainModule(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { agent: { type: "string" }, exclude: { type: "string", multiple: true },
      "resume-id": { type: "string" } } });
    const exclude = (values.exclude || []).map(Number).filter(Number.isInteger);
    reapPriorHermesRuns({ agentId: values.agent || "", resumeId: values["resume-id"] || "", exclude });
  } catch {
    // Best-effort by contract.
  }
}
