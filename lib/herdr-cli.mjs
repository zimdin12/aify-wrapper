// Talking to a running Herdr through its own CLI.
//
// WHY THE CLI AND NOT THE SOCKET. Herdr's binary already speaks its socket protocol, resolves which
// server to talk to, and is on PATH wherever a pane exists; `HERDR_BIN_PATH` names the exact binary
// that opened this pane, so using it removes the whole class of "talked to a different Herdr".
//
// EVERY CALL IS ALLOWED TO FAIL. This runs inside a wrapper the operator is launching. A Herdr that
// is busy, mid-handoff, or gone must degrade to "the pane is not labelled" and never to "the agent
// did not start", so the result carries the failure instead of throwing it.

import { spawnSync } from "node:child_process";

import { resolveHerdrBinary } from "./herdr-binary.mjs";

/** The result of one CLI call: what it printed, whether it worked, and why not. */
function outcome({ ok, json = null, stdout = "", stderr = "", error = null }) {
  return Object.freeze({ ok, json, stdout, stderr, error });
}

/**
 * Run one `herdr` subcommand and parse its JSON.
 *
 * THE EXIT STATUS IS THE ONE UNDER TEST. `spawnSync` reports the status of the binary itself, not of
 * anything it was piped through, which is the distinction this repo has been bitten by before.
 */
export function herdr(argv, { bin, env = process.env, timeoutMs = 15000, run = spawnSync } = {}) {
  // RESOLVED, NOT ASSUMED. The Herdr install directory is not on PATH by default on Windows, so a
  // bare "herdr" fails from an ordinary prompt while working for anything Herdr itself started.
  const exe = bin || resolveHerdrBinary({ env }).bin;
  let result;
  try {
    result = run(exe, argv, { encoding: "utf8", timeout: timeoutMs, env, windowsHide: true });
  } catch (err) {
    return outcome({ ok: false, error: String(err?.message || err) });
  }
  if (result?.error) return outcome({ ok: false, error: String(result.error.message || result.error) });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  if (result?.status !== 0) return outcome({ ok: false, stdout, stderr, error: `herdr exited ${result?.status}` });
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // A non-JSON body is not a failure of the command; some verbs print nothing at all.
    return outcome({ ok: true, stdout, stderr });
  }
  // Herdr reports its own refusals in the body with a zero exit, so the body decides.
  if (json && typeof json === "object" && json.error) {
    return outcome({ ok: false, json, stdout, stderr, error: String(json.error.message || json.error.code || "herdr error") });
  }
  return outcome({ ok: true, json, stdout, stderr });
}

/**
 * Every pane the running Herdr knows about.
 *
 * AN UNREADABLE LISTING IS AN EMPTY ONE ONLY FOR THE CALLER THAT ASKED FOR PANES TO RESTORE, and
 * that caller must not then prune its ledger — a zero it cannot distinguish from "Herdr is down"
 * would delete every record on the host. So the failure is returned, not flattened.
 */
export function listPanes(options = {}) {
  const result = herdr(["pane", "list"], options);
  if (!result.ok) return { ok: false, panes: [], error: result.error };
  const panes = result.json?.result?.panes;
  if (!Array.isArray(panes)) return { ok: false, panes: [], error: "pane list returned no panes array" };
  return { ok: true, panes, error: null };
}
