// What an agent's definition supplies to its launcher (P0 C9): role, model and effort, as defaults, and its standing
// instructions, which bin/aify-definition.mjs hands the runtime as a file.
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

import { definitionBytesProblems, idProblems, isCounter } from "./agent-definition-schema.mjs";

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
 *   | {outcome: "found", file: string, role: string, model: string, effort: string, instructions: string}}
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
  return { outcome: "found", file, role: body.agent.role, model: body.agent.model, effort: body.agent.effort,
    instructions: typeof body.agent.instructions === "string" ? body.agent.instructions : "",
    incarnation: body.incarnation, revision: body.revision };
}

/**
 * What a MANAGED launch may take from the definition it read: `{use}` its instructions, `{warn}` and start without
 * them, or `{refuse}`. PURE.
 *
 * ONE REVISION PER START (comms P0 C7). aify-env admits a defined start at one incarnation and revision and hands the
 * launch AIFY_DEFINITION_INCARNATION and AIFY_DEFINITION_REVISION; the payload's model, effort and role are that
 * revision's. The file read here comes later, after the lease claim, so an edit in between would pair revision R's
 * defaults with R+1's instructions. The file must still be the admitted revision, or the start is refused: an edit,
 * a withdrawal or an unreadable file all mean "start it again", never a start from two revisions.
 * AN AIFY-ENV THAT BINDS NOTHING (before 0.9.9) gets the launch it had before instructions reached claude: started
 * without them, and told so when the file holds some.
 */
export function managedBinding(result, env) {
  const bound = ["AIFY_DEFINITION_INCARNATION", "AIFY_DEFINITION_REVISION"].map((name) => env[name] ?? "");
  if (bound.every((value) => value === "")) {
    if (result.outcome === "found" && result.instructions !== "") {
      return { warn: "instructions not loaded: this aify-env does not bind the definition revision" };
    }
    if (result.outcome === "refused") return { warn: `the definition cannot be read here (${result.problems.join("; ")})` };
    return {};
  }
  // IN THE STORE'S OWN DOMAIN, ON BOTH SIDES, BEFORE ANY COMPARISON: a counter is the schema's isCounter, a number
  // that is a safe integer of at least 1. readDefinition validates the file as a CANDIDATE, which leaves the
  // store-owned counters unjudged, and a comparison of their text admitted "3", [3] and 0 (review of 022a9bb).
  const unbound = COUNTERS.filter((field, at) => !(/^[1-9][0-9]*$/.test(bound[at]) && Number.isSafeInteger(Number(bound[at]))));
  if (unbound.length) {
    return { refuse: `the start's binding is not two positive counters (${unbound.map((field) => `${field} ${JSON.stringify(bound[COUNTERS.indexOf(field)])}`).join(", ")})` };
  }
  const [incarnation, revision] = bound.map(Number);
  const admitted = `incarnation ${incarnation} revision ${revision}`;
  if (result.outcome === "missing") return { refuse: `this start was admitted at ${admitted}, and the definition is gone; start it again` };
  if (result.outcome === "refused") {
    return { refuse: `this start was admitted at ${admitted}, and the definition cannot be read now (${result.problems.join("; ")}); start it again` };
  }
  const unrecorded = COUNTERS.filter((field) => !isCounter(result[field]));
  if (unrecorded.length) {
    return { refuse: `this start was admitted at ${admitted}, and the definition's ${unrecorded.map((field) => `${field} ${JSON.stringify(result[field])}`).join(", ")} is not a positive counter; start it again` };
  }
  if (result.incarnation !== incarnation || result.revision !== revision) {
    return { refuse: `this start was admitted at ${admitted}, and the definition is now incarnation ${result.incarnation} revision ${result.revision}; start it again` };
  }
  return { use: true };
}

/** The two store-owned fields a managed start is bound by, in the order the env names them. */
const COUNTERS = ["incarnation", "revision"];

const quoted = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** A control character, as the schema means one (`agent.name`'s rule). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The assignments a launcher evaluates: the file, and for a found definition its three defaults and whether it holds
 * instructions (written only once the launch is admitted: `instructionsAssignment`).
 */
export function shellAssignments(result) {
  const lines = [`AIFY_DEF_FILE=${quoted(result.outcome === "found" ? result.file : "")}`];
  if (result.outcome === "found") {
    lines.push(`AIFY_DEF_ROLE=${quoted(result.role)}`, `AIFY_DEF_MODEL=${quoted(result.model)}`, `AIFY_DEF_EFFORT=${quoted(result.effort)}`,
      `AIFY_DEF_HAS_INSTRUCTIONS=${result.instructions ? "true" : "false"}`,
      // Named because the shell cannot carry them: a launcher that selects one refuses (review of P6r2, L2).
      `AIFY_DEF_CONTROL=${quoted(["model", "effort"].filter((field) => CONTROL.test(result[field])).join(" "))}`);
  }
  return lines;
}

/** The assignment naming the file the agent's instructions were written to, "" when there are none. */
export function instructionsAssignment(file) {
  return `AIFY_DEF_INSTRUCTIONS_FILE=${quoted(file)}`;
}
