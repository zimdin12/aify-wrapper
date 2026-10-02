// What an agent's definition supplies to its launcher (P0 C9): role, model and effort, as defaults.
//
// READ, NEVER WRITTEN. aify-env's DefinitionStore is the only writer of ~/.aify/agent-definitions, and
// asking it would run its recovery, which writes. A launcher reads the one file, validates it with the
// schema aify-env validates with (agent-definition-schema.mjs, a copy held to aify-env's bytes by
// tests/the-definition-schema-is-aify-envs.test.js), and decides nothing else.
//
// MISSING IS TODAY'S BEHAVIOUR, and only missing is. A file that is invalid, unreadable, not a regular
// file, or for another harness is REFUSED: a launcher that quietly started without the definition the
// operator wrote would look like it honoured it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { definitionBytesProblems, idProblems } from "./agent-definition-schema.mjs";

/** The contract's configuration-error exit, which every launcher already uses. */
export const EXIT_REFUSED = 78;

/** Where the definitions live: `AIFY_AGENT_DEFINITIONS_DIR` for tests, else aify-env's own default. */
export function definitionsDir(env = process.env, home = os.homedir()) {
  return env.AIFY_AGENT_DEFINITIONS_DIR || path.join(home, ".aify", "agent-definitions");
}

/**
 * The definition of `id` as a launcher for `harness` may use it.
 * @returns {{outcome: "missing", file: string}
 *   | {outcome: "refused", file: string, problems: string[]}
 *   | {outcome: "found", file: string, role: string, model: string, effort: string}}
 */
export function readDefinition({ id, harness, dir, io = fs }) {
  const named = idProblems(id);
  if (named.length) return { outcome: "refused", file: "", problems: named };
  const file = path.join(dir, `${id}.json`);
  const unreadable = (error) => ({ outcome: "refused", file, problems: [`file: unreadable (${error.code || error.message})`] });
  let bytes;
  try {
    if (!io.lstatSync(file).isFile()) return { outcome: "refused", file, problems: ["entry: not-a-regular-file"] };
    bytes = io.readFileSync(file);
  } catch (error) {
    return error.code === "ENOENT" ? { outcome: "missing", file } : unreadable(error);
  }
  const { problems, body } = definitionBytesProblems(bytes, id);
  if (problems.length) return { outcome: "refused", file, problems };
  if (body.agent.harness !== harness) {
    return { outcome: "refused", file, problems: [`it defines a ${body.agent.harness} agent, and this is the ${harness} launcher`] };
  }
  return { outcome: "found", file, role: body.agent.role, model: body.agent.model, effort: body.agent.effort };
}

const quoted = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** A control character, as the schema means one (`agent.name`'s rule). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The assignments a launcher evaluates: the file, and for a found definition its three defaults. */
export function shellAssignments(result) {
  const lines = [`AIFY_DEF_FILE=${quoted(result.outcome === "found" ? result.file : "")}`];
  if (result.outcome === "found") {
    lines.push(`AIFY_DEF_ROLE=${quoted(result.role)}`, `AIFY_DEF_MODEL=${quoted(result.model)}`, `AIFY_DEF_EFFORT=${quoted(result.effort)}`,
      // Named because the shell cannot carry them: a launcher that selects one refuses (review of P6r2, L2).
      `AIFY_DEF_CONTROL=${quoted(["model", "effort"].filter((field) => CONTROL.test(result[field])).join(" "))}`);
  }
  return lines;
}
