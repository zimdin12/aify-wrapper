#!/usr/bin/env node
// exists <native-id>: selected-profile metadata check. pin <bridge> <endpoint> <agent>: service-owned lookup.
import os from "node:os";
import { isMainModule } from "../lib/main-module.mjs";
import { ClaudePinLookup, ClaudeTranscripts, pinnedResumeEligible } from "../lib/claude-sessions.mjs";

const FRESH_REASON = {
  none: "the service has no pinned Claude session",
  "wrong-runtime": "the service pin belongs to another runtime",
  unavailable: "the service pin lookup is unavailable",
  "missing-transcript": "the pinned transcript is not in the selected Claude profile",
};

if (isMainModule(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "exists") process.exit(new ClaudeTranscripts({ env: process.env, home: os.homedir() }).find(args[0]) ? 0 : 1);
    if (mode === "select") {
      if (args.length !== 8 || args.slice(3, 7).some(value => value !== "true" && value !== "false")) process.exit(0);
      if (!pinnedResumeEligible({ agentId: args[2], explicit: args[3] === "true", selector: args[4] === "true", fresh: args[5] === "true", shared: args[6] === "true", resumeId: args[7], env: process.env })) process.exit(0);
    } else if (mode !== "pin" || args.length !== 3) process.exit(1);
    const [bridge, endpoint, agentId] = args;
    const result = new ClaudePinLookup({ bridge, endpoint, agentId, env: process.env, home: os.homedir() }).lookup();
    if (result.status === "found") process.stdout.write(result.session);
    else process.stderr.write(`[claude-aify] ${FRESH_REASON[result.status] || FRESH_REASON.unavailable}; starting a fresh session.\n`);
  } catch {
    if (mode === "pin" || mode === "select") process.stderr.write(`[claude-aify] ${FRESH_REASON.unavailable}; starting a fresh session.\n`);
    else process.exitCode = 1;
  }
}
