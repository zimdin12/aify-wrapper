#!/usr/bin/env node
// The defaults an agent's definition gives its launcher (P0 C9), as shell assignments.
//
//   aify-definition <agent id> <claude|codex|hermes>
//
// Exit 0 with `AIFY_DEF_FILE=''` when no definition exists (the launcher behaves as before), exit 0
// with the file and AIFY_DEF_ROLE / AIFY_DEF_MODEL / AIFY_DEF_EFFORT when it does, and exit 78 with the
// problems on stderr when it is refused. The launcher evaluates stdout only on exit 0.

import process from "node:process";

import { definitionsDir, EXIT_REFUSED, readDefinition, shellAssignments } from "../lib/agent-definition-defaults.mjs";
import { isMainModule } from "../lib/main-module.mjs";

if (isMainModule(import.meta.url)) {
  const [id = "", harness = ""] = process.argv.slice(2);
  const result = readDefinition({ id, harness, dir: definitionsDir() });
  if (result.outcome === "refused") {
    process.stderr.write(`the definition of ${id}${result.file ? ` (${result.file})` : ""} is refused: ${result.problems.join("; ")}\n`);
    process.exitCode = EXIT_REFUSED;
  } else {
    process.stdout.write(`${shellAssignments(result).join("\n")}\n`);
  }
}
