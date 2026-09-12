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
  // `code` IS HERDR'S OWN NAME FOR THE FAILURE, when it gave one. `error` is prose for a person;
  // `code` is what a caller may branch on, and the one that matters is `server_not_running`.
  const code = json && typeof json === "object" && json.error ? String(json.error.code || "") || null : null;
  return Object.freeze({ ok, json, stdout, stderr, error, code });
}

/** Herdr's answer when nothing is listening on the socket. Measured 2026-09-13, see `serverAnswer`. */
export const SERVER_NOT_RUNNING = "server_not_running";

/**
 * What one CLI result says about the server behind its socket: "serving", "not-running" or "unknown".
 *
 * A FAILED READ IS NOT A DEAD SERVER. Every caller that asked "is it gone?" used `!result.ok`, and
 * `ok` is false for a timeout, a busy server and a binary that could not be spawned as much as for a
 * server that is not there -- so `--prune` could delete a LIVE invocation's receipts and `--stop`
 * could report "confirmed gone" on nothing but a slow answer. Found by review.
 *
 * ONLY HERDR'S OWN REFUSAL COUNTS AS DEATH. Measured against Herdr 0.9.0 on Windows: a socket path
 * with nothing behind it AND a leftover socket file with no server both exit 1 with the body code
 * `server_not_running`, while a live server answers exit 0. Anything else could not tell.
 */
export function serverAnswer(result) {
  if (result?.ok) return "serving";
  if (result?.code === SERVER_NOT_RUNNING) return "not-running";
  return "unknown";
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
  if (result?.status !== 0) {
    // THE BODY IS READ ON A FAILING EXIT TOO, because that is where Herdr says WHY -- and "nothing is
    // running here" is the one failure a caller must be able to tell apart from "could not ask".
    //
    // FROM STDERR, measured: on a failing exit Herdr 0.9.0 writes that JSON body to stderr and leaves
    // stdout EMPTY. The first version of this parsed stdout only, passed a unit test whose fake put
    // the body there, and read every dead socket as "unknown" -- which would have made `--prune`
    // remove nothing at all. Caught by a live negative control, not by the suite.
    let body = null;
    for (const stream of [stdout, stderr]) {
      try { body = JSON.parse(stream.trim()); break; } catch { body = null; }
    }
    return outcome({ ok: false, json: body, stdout, stderr, error: `herdr exited ${result?.status}` });
  }
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
