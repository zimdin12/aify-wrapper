// What `herdr-aify env` invocations leave on this host, and the two commands that read it: `--status` says what is
// there and which one is running, `--prune` deletes what nothing is running. Every invocation lives under one profile
// root; `--stop` is lib/herdr-stop.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { herdr, serverAnswer } from "./herdr-cli.mjs";
import { resolveHerdrBinary } from "./herdr-binary.mjs";
import { profileOwnerState } from "./herdr-owner.mjs";
import { herdrServerEnv, profilePaths } from "./herdr-profile.mjs";

/** Every invocation of every herdr-aify on this host lives under here. */
export function defaultProfileRoot({ home = os.homedir() } = {}) {
  return path.join(home, ".aify", "herdr");
}

/** What previous invocations left on this host, for an operator who wants to look. */
export function invocationsOnDisk({ profileRoot = defaultProfileRoot(), io = fs } = {}) {
  const dir = path.join(profileRoot, "invocations");
  let names = [];
  try {
    names = io.readdirSync(dir);
  } catch {
    return [];
  }
  return names.map(name => {
    const root = path.join(dir, name);
    const used = ["owned-processes.json", "ready.json", "claimed.json"].filter(file =>
      io.existsSync(path.join(root, file)),
    );
    return { invocation: name, root, used, spent: used.length > 0 };
  });
}

/**
 * Which recorded invocations may be deleted, given which ones something is still answering for.
 *
 * PURE, and separate from the deleting, because the deciding is the part that can be wrong in a way
 * nobody notices until state is already gone.
 *
 * A LIVE INVOCATION IS ONE WHOSE OWN SOCKET ANSWERS, not one the owner pointer happens to name. The
 * pointer records a single current instance, so keying on it would delete the directory of a Herdr
 * that is still running because its launcher was killed without a signal -- which is the exact
 * situation this feature already has a command for.
 *
 * A DIRECTORY WHOSE NAME IS NOT AN INVOCATION IS LEFT ALONE. Nothing here put it there, so nothing
 * here should decide it is rubbish.
 */
export function prunePlan(records, { live = [], unknown = [] } = {}) {
  const answering = new Set(live);
  // A PROBE THAT COULD NOT TELL KEEPS THE DIRECTORY. Deleting on a timeout would remove the receipts
  // of an instance that is merely slow -- the receipts that stop a later launch adopting its workers.
  const unanswered = new Set(unknown);
  const remove = [];
  const keep = [];
  for (const record of records) {
    if (!UUID_V4.test(record.invocation)) keep.push({ ...record, why: "not an invocation" });
    else if (answering.has(record.invocation)) keep.push({ ...record, why: "still answering" });
    else if (unanswered.has(record.invocation)) keep.push({ ...record, why: "could not tell whether it is running" });
    else remove.push(record);
  }
  return Object.freeze({ remove, keep });
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Delete what previous invocations left behind, keeping anything still running.
 *
 * WHY THIS EXISTS. Every launch mints a directory and nothing ever removed one, so `--status` -- the
 * command an operator reaches for when something is wrong -- grows a page longer every time the
 * feature is used, and the useful line is buried under the residue of launches that failed months
 * ago. Twelve had accumulated in a day of testing.
 *
 * EACH ONE IS PROBED ON ITS OWN SOCKET before it is deleted, so a running instance whose launcher
 * was killed keeps its context file and its receipts -- which are what stop a later invocation
 * adopting its workers.
 */
export function pruneInvocations({ profileRoot = defaultProfileRoot(), env = process.env, io = fs, cli = herdr } = {}) {
  const records = invocationsOnDisk({ profileRoot, io });
  const answers = records
    .filter(record => UUID_V4.test(record.invocation))
    .map(record => {
      const paths = profilePaths({ profileRoot, invocation: record.invocation });
      const read = cli(["pane", "list"], { bin: resolveHerdrBinary({ env }).bin, env: herdrServerEnv(env, paths) });
      return { invocation: record.invocation, answer: serverAnswer(read) };
    });
  // ONLY HERDR SAYING "NOTHING IS RUNNING HERE" MAKES A DIRECTORY REMOVABLE. See `serverAnswer`.
  const live = answers.filter(a => a.answer === "serving").map(a => a.invocation);
  const unknown = answers.filter(a => a.answer === "unknown").map(a => a.invocation);

  const plan = prunePlan(records, { live, unknown });
  let removed = 0;
  for (const record of plan.remove) {
    try {
      io.rmSync(record.root, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      process.stderr.write(`herdr-aify: could not remove ${record.invocation}: ${err?.message || err}\n`);
    }
  }
  const kept = plan.keep.map(record => `${record.invocation} (${record.why})`);
  process.stderr.write(`herdr-aify: removed ${removed} of ${records.length} invocation(s)${kept.length ? `; kept ${kept.join(", ")}` : ""}\n`);
  return 0;
}

/**
 * `--status`: every invocation on disk, `current` for the one the profile's pointer names, and for that one whether
 * its own socket is `serving` (true, false, or "unknown" when the socket could not tell).
 *
 * SPENT IS NOT DEAD. `spent` says an invocation's receipts exist, so its id is never used again; a running instance
 * is spent from its first second. Read as liveness it told an operator a running instance was finished (work-PC
 * rehearsal, 2026-10-28), so the answer to "which one is running" is given here, from the socket, not left to a
 * field that never said it.
 *
 * ONLY THE CURRENT ONE IS ASKED. A second `herdr-aify env` joins the instance the pointer names rather than start
 * another, so that is the one an operator can reach; `--prune` asks every one, because it deletes.
 */
export async function invocationStatus({ profileRoot = defaultProfileRoot(), env = process.env, io = fs, cli = herdr, owner = profileOwnerState } = {}) {
  const rows = invocationsOnDisk({ profileRoot, io });
  const { invocation: current = null } = await owner(profileRoot, { io });
  return rows.map(row => {
    if (row.invocation !== current) return { ...row, current: false };
    const paths = profilePaths({ profileRoot, invocation: current });
    const answer = serverAnswer(cli(["pane", "list"], { bin: resolveHerdrBinary({ env }).bin, env: herdrServerEnv(env, paths) }));
    return { ...row, current: true, serving: answer === "unknown" ? "unknown" : answer === "serving" };
  });
}
