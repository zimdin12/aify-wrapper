// The persistent Herdr that plain `herdr-aify` attaches to.
//
// THE TWO MODES WANT OPPOSITE LIFETIMES, and giving both the same one is what broke this half.
// The operator's ruling:
//
//   "ordinary herdr-aify should remember previous instance agents like ordinary herdr does, that
//    herdr-aify env is the one that really acts differently. herdr-aify is like ordinary, but
//    supports our -aify stuff so they could be saved etc."
//
//   `herdr-aify env`  a fresh invocation that DIES with the command. Ephemeral on purpose: a new one
//                     must never adopt the previous one's workers.
//   `herdr-aify`      ONE Herdr that outlives the command. Closing the TUI DETACHES, exactly as it
//                     does in an ordinary Herdr, and the next launch attaches to the same session
//                     with its spaces and its agents still there.
//
// WHAT WENT WRONG WITHOUT IT. A plain launch minted a throwaway profile, so every launch was a first
// launch: a resident `claude-aify` was started, detached from, and then gone from the next launch --
// while aify-comms still reported the agent ONLINE, because the process was still running with
// nothing left pointing at it. That is the orphan this module exists to stop making.
//
// IT STARTS AT MOST ONE. The server is started only when nothing answers on the socket, so running
// the command twice attaches twice rather than racing two servers onto one profile.

import { herdrServerEnv } from "./herdr-profile.mjs";

/** Does a Herdr answer on this profile's socket? The only thing that decides start-or-attach. */
export function residentIsServing({ paths, env, bin, cli }) {
  return Boolean(cli(["pane", "list"], { bin, env: serverEnvFor(env, paths) }).ok);
}

/**
 * The environment that points a Herdr -- server or client -- at the resident profile.
 *
 * THE SAME ENVIRONMENT A DEDICATED INSTANCE GETS, and building it by hand here was wrong in two
 * ways that only show up on a host that already runs Herdr. It set the three roots and nothing else,
 * so: a `herdr-aify` launched from inside an ordinary Herdr pane carried that pane's `HERDR_PANE_ID`,
 * `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID` into the resident and every agent started in it, which is
 * how a pane records itself as belonging to somebody else's Herdr; and with no `AIFY_HERDR_LEDGER`
 * the resident wrote its pane records into `~/.aify/herdr/panes.json`, the ledger the operator's own
 * Herdr uses -- where a restore prunes every record whose pane IT cannot see, so the two sessions
 * delete each other's agents. `herdrServerEnv` already answers all of that; the resident needed the
 * same answer, not a second one.
 */
export function serverEnvFor(env, paths) {
  return herdrServerEnv(env, paths);
}

/**
 * Make sure the resident Herdr is up, and say whether this call is what started it.
 *
 * THE CALLER NEEDS TO KNOW WHICH, because only a fresh server needs its plugin linked and only a
 * fresh server has to be waited for -- and because "attached to your existing session" and "started
 * a new one" are different things to tell an operator.
 */
export async function ensureResident({ paths, env, bin, cli, spawn, io, sleep, attempts = 40, waitMs = 250 }) {
  if (residentIsServing({ paths, env, bin, cli })) return { ok: true, started: false, attached: true };

  io.mkdirSync(paths.root, { recursive: true });
  const serverEnv = serverEnvFor(env, paths);
  // INDEPENDENT: this server outlives the command that started it. See `processes.spawn`.
  const child = spawn(bin, ["server"], { env: serverEnv, independent: true });
  // THE SPAWN IS AWAITED, not sampled. Node reports a spawn failure on a LATER TICK, by rejecting
  // `started`, so `failed` is still false here -- and a rejection nobody observes ends the process.
  // Found by review: a stale `HERDR_BIN_PATH` crashed the launcher with an unhandled rejection instead
  // of saying the server could not start. The dedicated supervisor already awaits it; this did not.
  if (child?.started) {
    try {
      await child.started;
    } catch (err) {
      return { ok: false, started: false, error: String(err?.message || err) };
    }
  }
  if (child?.failed) return { ok: false, started: false, error: child.error || "herdr server did not start" };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(waitMs);
    // A SERVER THAT HAS ALREADY EXITED WILL NEVER ANSWER, so waiting out the clock on it reports a
    // timeout where the truth is that it died -- the same misreport the dedicated instance had.
    if (child?.exited) return { ok: false, started: false, error: "herdr server exited before it was ready" };
    if (residentIsServing({ paths, env, bin, cli })) return { ok: true, started: true, attached: false };
  }
  return { ok: false, started: false, error: `herdr server was not ready within ${(attempts * waitMs) / 1000}s` };
}
