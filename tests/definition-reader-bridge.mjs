// A bridge directory that holds aify-wrapper's definition reader and nothing of the operator's.
//
// Every launcher reads its agent's definition before it starts, and refuses with 78 when it cannot run
// the reader (P0 C9; review of P6, R2: not being able to look is not finding nothing). A fixture that
// renders against install.sh's default bridge, ~/.aify-comms/mcp/stdio, runs the OPERATOR's installed
// reader, and through it reads the operator's ~/.aify/agent-definitions: an ambient input that decides
// the result. Before R2 these fixtures passed only because the installed bridge had no reader yet.
//
// So a fixture that runs a launcher past its definition read renders with `--bridge-dir` at a bridge
// built here, and runs with `definitionsEnv` pointing the reader at an empty directory of its own.
// Only the reader's files are copied: a whole aify-wrapper would let the launcher find and run its
// lease script, which writes under the real home.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The reader and what it imports, as installed under `<bridge>/node_modules/aify-wrapper`. */
export const READER_FILES = Object.freeze([
  "bin/aify-definition.mjs", "lib/agent-definition-defaults.mjs", "lib/agent-definition-schema.mjs", "lib/main-module.mjs",
]);

/** Copy the reader into `bridge` (created if missing) and return it. */
export function readerBridge(bridge) {
  for (const file of READER_FILES) {
    const to = path.join(bridge, "node_modules", "aify-wrapper", file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), to);
  }
  return bridge;
}

/** The variables that point the reader at `dir`, created empty: no definition unless a test writes one. */
export function definitionsEnv(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return { AIFY_AGENT_DEFINITIONS_DIR: dir };
}
