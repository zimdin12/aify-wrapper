// What endpoint is already installed at a destination.
//
// A reinstall should not make an operator retype an address they gave once. The launcher carries it,
// so it can be read out of the file. Reading, never running: executing a launcher to interrogate it
// starts a coding-agent runtime, which is a large side effect for a question.

import fs from "node:fs";
import path from "node:path";

// The rendered assignment, anchored as a line so a mention inside a comment or a doc cannot answer.
// The capture is the baked fallback -- the part `--endpoint` supplied.
//
// Depth-agnostic on purpose. claude nests once; hermes nests TWICE, falling back through a second
// variable before the baked default. A pattern written against claude's single level matched nothing
// for hermes, and aify-comms' redeploy treats "nothing recovered" as "use loopback" -- so a
// hermes-only host would have had every wrapper repointed at 127.0.0.1. The baked URL is the innermost
// default, so the greedy `.*` before `:-` takes the last one whatever the depth.
const ENDPOINT_LINE =
  /^HARNESS_ENDPOINT="\$\{HARNESS_ENDPOINT-.*:-([^}"]*)\}+"$/m;

// Every launcher this package installs. A destination may hold any subset.
const LAUNCHERS = ["claude-aify", "codex-aify", "hermes-aify", "pi-aify", "omp-aify"];

/**
 * The endpoint baked into a single launcher file, or null.
 *
 * Null covers every way the answer can be absent -- unreadable file, no marker, an unrendered
 * `@@PLACEHOLDER@@` -- because each of those means "no endpoint to reuse", and a caller that treats
 * a placeholder as an address would bake literal `@@ENDPOINT@@` into the next install.
 */
export function endpointInFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = ENDPOINT_LINE.exec(text);
  if (!match) return null;
  // Group 1, and there is only one now: the old pattern captured the variable NAME as well, and
  // dropping that group while still reading match[2] made every launcher read as having no endpoint.
  const value = match[1];
  if (!value) return null;
  if (/^@@[A-Z0-9_]+@@$/.test(value)) return null;
  return value;
}

/**
 * The endpoint installed in a directory, or null if none of the launchers there carries one.
 *
 * Launchers are checked in a fixed order so the answer does not depend on directory listing order.
 * Where two launchers disagree the first wins, which is the same rule as "the endpoint you last
 * installed with"; a host that genuinely wants two endpoints passes --endpoint.
 */
export function endpointInstalledAt(dir) {
  for (const name of LAUNCHERS) {
    const found = endpointInFile(path.join(dir, name));
    if (found) return found;
  }
  return null;
}
