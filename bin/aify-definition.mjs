#!/usr/bin/env node
// The defaults an agent's definition gives its launcher (P0 C9), as shell assignments.
//
//   aify-definition <agent id> <claude|codex|hermes> [--managed] [--write-instructions]
//
// Exit 0 with `AIFY_DEF_FILE=''` when no definition exists (the launcher behaves as before), exit 0
// with the file and AIFY_DEF_ROLE / AIFY_DEF_MODEL / AIFY_DEF_EFFORT when it does, and exit 78 with the
// problems on stderr when it is refused. The launcher evaluates stdout only on exit 0.
//
// --managed: a launch the host started, whose payload carries the defaults the host already checked. Nothing else is
// printed. Claude's instructions come only from the revision the host admitted (AIFY_DEFINITION_INCARNATION and
// _REVISION, lib/agent-definition-defaults.mjs managedBinding): a file at another revision, or unreadable, refuses the
// start; a host that binds none gets a start without them, and a warning.
//
// THE INSTRUCTIONS. A claude definition's `agent.instructions` is written to the agent's owner-only
// ~/.aify/sessions/<id>/instructions.txt (lib/session-folder.mjs) by `--write-instructions`, which prints
// AIFY_DEF_INSTRUCTIONS_FILE; empty instructions remove that file and name none. The launcher asks for that only once
// the lease admits its start: the file is the agent's one, and a second launch the lease refuses must not rewrite the
// running session's. Codex and hermes cannot carry them yet (hermes' TUI gateway reads no per-session prompt, read
// from its source), so a definition of theirs WITH instructions is refused rather than started without them: that
// would look as if the operator's rules were honoured.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { definitionsDir, EXIT_REFUSED, instructionsAssignment, managedBinding, readDefinition, shellAssignments } from "../lib/agent-definition-defaults.mjs";
import { isMainModule } from "../lib/main-module.mjs";
import { sessionFolder, sessionsRoot, writeSessionFile } from "../lib/session-folder.mjs";

const INSTRUCTIONS_FILE = "instructions.txt";

function refuse(id, file, problems) {
  process.stderr.write(`the definition of ${id}${file ? ` (${file})` : ""} is refused: ${problems.join("; ")}\n`);
  process.exitCode = EXIT_REFUSED;
}

/** Write the agent's instructions to its session folder, or remove the file when there are none; the file's path or "". */
async function placeInstructions(id, result) {
  if (result.outcome !== "found") return "";
  if (result.instructions === "") {
    // Emptied since the last launch: the old text must not be handed on by anything that finds the file.
    fs.rmSync(path.join(sessionsRoot(), id, INSTRUCTIONS_FILE), { force: true });
    return "";
  }
  const folder = await sessionFolder({ agentId: id });
  if (!folder.ok) {
    refuse(id, result.file, [`agent.instructions: ${folder.problem}`]);
    return "";
  }
  return writeSessionFile(folder.dir, INSTRUCTIONS_FILE, result.instructions);
}

if (isMainModule(import.meta.url)) {
  const [id = "", harness = "", ...flags] = process.argv.slice(2);
  const managed = flags.includes("--managed");
  const result = readDefinition({ id, harness, dir: definitionsDir() });
  if (managed && flags.includes("--write-instructions")) {
    // Claude's managed write, after the lease claim: only from the revision aify-env admitted (managedBinding).
    const verdict = managedBinding(result, process.env);
    if (verdict.refuse) refuse(id, result.file, [verdict.refuse]);
    else {
      if (verdict.warn) process.stderr.write(`the definition of ${id}: ${verdict.warn}; this managed launch starts WITHOUT its instructions\n`);
      const file = verdict.use ? await placeInstructions(id, result) : "";
      if (!process.exitCode) process.stdout.write(`${instructionsAssignment(file)}\n`);
    }
  } else if (result.outcome === "refused" && managed) {
    // The host checked this definition and launched on it; a launcher that disagrees does not stop the fleet over it.
    // It says so, loudly, because the agent then starts without whatever instructions the file holds.
    process.stderr.write(`the definition of ${id} (${result.file}) cannot be read here (${result.problems.join("; ")}): `
      + "this managed launch starts WITHOUT its instructions\n");
    process.stdout.write(`${instructionsAssignment("")}\n`);
  } else if (result.outcome === "refused") {
    refuse(id, result.file, result.problems);
  } else if (result.outcome === "found" && result.instructions !== "" && harness !== "claude") {
    refuse(id, result.file, [`agent.instructions: the ${harness} launcher cannot hand them to the runtime yet, so it does not start without them`]);
  } else if (flags.includes("--write-instructions")) {
    const file = await placeInstructions(id, result);
    if (!process.exitCode) process.stdout.write(`${instructionsAssignment(file)}\n`);
  } else if (!managed) {
    process.stdout.write(`${shellAssignments(result).join("\n")}\n`);
  }
}
