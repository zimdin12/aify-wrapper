// A wrapper directory that holds aify-wrapper's definition reader and nothing of the operator's.
//
// Every launcher reads its agent's definition before it starts, and refuses with 78 when it cannot run
// the reader (P0 C9; review of P6, R2: not being able to look is not finding nothing). The launcher finds
// the reader in the wrapper directory it was rendered with (`--wrapper-dir`, `WRAPPER_DIR=`), and the reader
// reads `~/.aify/agent-definitions` unless told otherwise: an ambient input that decides the result.
//
// So a fixture that runs a launcher past its definition read renders with its wrapper directory here, and
// runs with `definitionsEnv` pointing the reader at an empty directory of its own. Only the readers and
// pure hook formatter are copied. The whole package would let the launcher run its lease script,
// which writes under the real home.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The readers and pure hook formatter, without any lease or runtime-start helpers. */
export const READER_FILES = Object.freeze([
  "bin/aify-definition.mjs", "bin/aify-definition.sh", "lib/agent-definition-defaults.mjs", "lib/agent-definition-schema.mjs", "lib/main-module.mjs",
  "bin/aify-claude-default-model.mjs", "lib/claude-default-model.mjs",
  "bin/aify-tool-hook-json.sh",
  // The per-launch session entries claude-aify writes (bin/aify-session-mcp.mjs), with the credential store's reader.
  "bin/aify-session-mcp.mjs", "lib/session-http.mjs", "lib/credential-custody.mjs", "lib/registry.mjs", "lib/session-hermes.mjs", "lib/session-codex.mjs",
  "lib/credential-file.mjs", "lib/machine-id.mjs", "lib/session-folder.mjs", "lib/process-identity.mjs",
]);

/** Copy the reader into `wrapper` (created if missing) and return it. */
export function readerWrapper(wrapper) {
  for (const file of READER_FILES) {
    const to = path.join(wrapper, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), to);
  }
  return wrapper;
}

/** The variables that point the reader at `dir`, created empty: no definition unless a test writes one. */
export function definitionsEnv(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return { AIFY_AGENT_DEFINITIONS_DIR: dir };
}
