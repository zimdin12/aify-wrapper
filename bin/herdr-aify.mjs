#!/usr/bin/env node
// herdr-aify — this host's aify-flavoured Herdr, in two modes with two lifetimes.
//
//   herdr-aify            THE ONE THIS HOST KEEPS. Wrapper support, no daemon, for RESIDENT sessions:
//                         leaving it DETACHES and the next launch comes back to the same spaces and
//                         the same agents, exactly as an ordinary Herdr does.
//   herdr-aify env        A FRESH INVOCATION THAT DIES WITH THE COMMAND, plus a dedicated aify-env in
//                         the first space, for MANAGED work. A new one never adopts an old one's
//                         workers -- that is what the invocation machinery is for, and it is why the
//                         two modes do not share a profile.
//   herdr-aify --status   what this host's invocations left behind
//   herdr-aify --stop     end the recorded instance, even if its launcher was killed without a signal
//   herdr-aify --prune    delete what dead invocations left behind
//   herdr-aify --no-attach  run headless instead of taking this terminal over with the Herdr TUI
//
// WHAT IT IS FOR, in the operator's words: "a dedicated Herdr instance with the actual aify-env
// process in its own space. Ending herdr-aify ends that Herdr instance, its env, and its workers. A
// new invocation starts without resurrecting the previous workers. Ordinary Herdr remains separate."
//
// THE SPLIT IT IMPLEMENTS. Launch and process lifetime belong to aify-wrapper, which is this file.
// Worker and PTY authority stay in aify-env, which is why this starts exactly one thing -- the
// dedicated daemon -- and then gets out of the way. It does not spawn workers, open their spaces or
// know what they are; the daemon does that through Herdr's own API.
//
// WHAT ORDINARY HERDR GETS FROM THIS FILE: nothing. Isolation is by XDG roots and a private socket,
// so an ordinary Herdr on the same machine is not attached to, read, written or superseded.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/main-module.mjs";
import { herdr, serverAnswer } from "../lib/herdr-cli.mjs";
import { resolveHerdrBinary } from "../lib/herdr-binary.mjs";
import { herdrServerEnv, profilePaths, residentPaths } from "../lib/herdr-profile.mjs";
import { ensureResident, serverEnvFor } from "../lib/herdr-resident.mjs";
import { HerdrOwner, clearProfileOwner, profileOwnerState, writeProfileOwner } from "../lib/herdr-owner.mjs";
import { HerdrAifyInstance } from "../lib/herdr-supervisor.mjs";

/** Every invocation of every herdr-aify on this host lives under here. */
export function defaultProfileRoot({ home = os.homedir() } = {}) {
  return path.join(home, ".aify", "herdr");
}

/** The real process control the supervisor is given. Injected there; concrete only here. */
const processes = {
  spawn(command, argv, { env, independent = false }) {
    // DETACHED ON POSIX, so the server leads a process GROUP and the backstop can reach its panes.
    // Without it `process.kill(-pid)` names a group that does not exist and fails with ESRCH every
    // time — the documented last resort could never once have fired. On Windows the group concept
    // does not apply and `taskkill /T` walks the tree instead.
    //
    // `independent` IS THE RESIDENT'S, and it is the difference between the two lifetimes rather
    // than a tuning knob. A dedicated instance's server must die with the command, so it stays a
    // ref'd child this process waits on and kills. The resident must OUTLIVE the command — the
    // launcher tells the operator "your agents keep running" as it exits — and a plain child makes
    // that a lie twice over: MEASURED on Windows, the launcher could not exit at all after the TUI
    // closed (a ref'd child handle holds the event loop open, and `main` sets `exitCode` rather than
    // calling `exit`), and the server shared the launcher's console, so closing the terminal tab
    // took it down with everything running inside it.
    const detached = independent || process.platform !== "win32";
    const child = spawn(command, argv, { env, stdio: "ignore", windowsHide: true, detached });
    // UNREF IS THE HALF THAT LETS THE LAUNCHER LEAVE. `detached` decides whether the child survives;
    // only `unref` stops this process waiting for it.
    if (independent) child.unref();
    const handle = { pid: child.pid || null, failed: false, error: null, exited: false, child };
    // A PROMISE, because `error` fires on a later tick: anything that reads a flag straight after
    // spawn reads it before the failure has happened. Node emits `spawn` only on a real start.
    handle.started = new Promise((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", err => reject(err));
    });
    child.on("error", err => {
      handle.failed = true;
      handle.error = String(err?.message || err);
    });
    child.on("exit", () => {
      handle.exited = true;
    });
    return handle;
  },
  attach(command, argv, { env }) {
    // THE OPERATOR'S OWN TERMINAL, which is the whole point of this operation and the reason it is
    // separate from `spawn`. `stdio: "inherit"` hands this console to the Herdr TUI: it draws, it
    // reads the keyboard, and Ctrl-C belongs to it rather than to this launcher.
    const child = spawn(command, argv, { env, stdio: "inherit", windowsHide: false });
    const exited = new Promise(resolve => {
      child.once("exit", code => resolve(code ?? 0));
      child.once("error", () => resolve(null));
    });
    return { child, exited, kill: () => child.kill() };
  },
  run(command, argv, { env }) {
    const result = herdr(argv, { bin: command, env });
    // `workspace create` answers with the new space, and the first pane in it is where the env goes.
    const paneId = result.json?.result?.root_pane?.pane_id || result.json?.result?.pane?.pane_id || null;
    return { ok: result.ok, error: result.error, code: result.code, paneId };
  },
  kill(pid) {
    // A tree kill, because the panes are grandchildren. The backstop, never the mechanism.
    if (process.platform === "win32") {
      return spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }).status === 0;
    }
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  },
};

const clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

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
 * What the operator is told a teardown did.
 *
 * DERIVED FROM THE OUTCOME, NOT ASSEMBLED FROM THE ATTEMPTS, because assembling it produced a line
 * that contradicted itself in the most ordinary case there is. Stopping the instance from another
 * shell printed `stopped (server did not stop, confirmed gone)`: the stop request failed BECAUSE the
 * server had already exited, and "did not stop" is the one thing that was not true. The teardown had
 * gone exactly to plan and the line read like a fault.
 *
 * So the sentence says WHAT IS GONE first -- which is this command's whole promise -- and how it went
 * second, as one clause rather than three independent flags a reader has to reconcile.
 */
export function teardownLine(result) {
  if (!result?.everServed) return "herdr-aify: nothing was started, so there is nothing to stop";
  const how = result.alreadyGone
    ? "the server had already exited"
    : result.serverStopped
      ? "server stopped cleanly"
      : result.killed
        ? "server refused to stop, tree killed"
        : "server refused to stop";
  // A stop that was ACCEPTED is still not a server that is gone, so the outcome is measured
  // separately from the request and always said out loud.
  // AND "COULD NOT TELL" IS ITS OWN ANSWER. A read that timed out is not a server still answering,
  // and saying it is sends the operator after a process that may already be gone.
  const outcome = result.confirmedGone
    ? "confirmed gone"
    : result.goneUnknown
      ? "could not confirm it is gone - check herdr-aify --status"
      : "STILL ANSWERING - check herdr-aify --status";
  return `herdr-aify: stopped (${how}, ${outcome})`;
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
 * Does this host already have a live instance?
 *
 * A FUNCTION, because the inline version of this was wrong for its whole life and nothing could see
 * it. It read `.live`, a field `profileOwnerState` has never returned, so the refusal never fired --
 * and a test of `profileOwnerState` stayed green throughout, because the defect was in the CALLER.
 * Pulled out so the call site itself is something a test can drive.
 */
export function alreadyRunning(state) {
  return Boolean(state?.owned);
}

/**
 * End the instance this host has recorded, whether or not its launcher is still around.
 *
 * WHY THIS EXISTS. Teardown normally runs from the launcher's signal handlers, and on Windows those
 * only fire for a real console Ctrl-C or a window close. `taskkill`, End Task, a dying parent, or an
 * SSH session going away deliver nothing — measured: a launcher killed that way left its dedicated
 * Herdr, its aify-env and their panes running, with an owner pointer nobody would ever clear.
 *
 * The instance is still perfectly addressable in that state: the owner pointer names the invocation,
 * and the invocation names a socket. So this is not a workaround, it is the direct route.
 */
async function stopRecorded({ profileRoot = defaultProfileRoot(), env = process.env } = {}) {
  const state = await profileOwnerState(profileRoot);
  if (!state?.invocation) {
    // THE RESIDENT IS THE OTHER THING THIS COMMAND CAN HOLD, and it outlives every launcher — so
    // "nothing recorded" is not the same as "nothing running". Detaching from it is the ordinary
    // way to leave; this is how an operator ends it on purpose.
    const bin = resolveHerdrBinary({ env }).bin;
    const paths = residentPaths({ profileRoot });
    const resident = serverEnvFor(env, paths);
    const before = herdr(["pane", "list"], { bin, env: resident });
    const running = serverAnswer(before);
    if (running === "serving") {
      const stopped = herdr(["server", "stop"], { bin, env: resident });
      const after = serverAnswer(herdr(["pane", "list"], { bin, env: resident }));
      process.stderr.write(
        `herdr-aify: this host's herdr — ${stopped.ok ? "stop accepted" : `stop refused (${stopped.error})`}, ` +
          `${goneWords(after)}\n`,
      );
      return after === "not-running" ? 0 : 1;
    }
    // "COULD NOT ASK" WAS REPORTED AS "NOTHING IS RUNNING", which is false in exactly the case where
    // the operator most needs the truth: a resident that is up but slow to answer.
    if (running === "unknown") {
      process.stderr.write(`herdr-aify: could not tell whether this host's herdr is running (${before.error}); nothing was stopped\n`);
      return 1;
    }
    process.stderr.write("herdr-aify: nothing is running here to stop\n");
    return 0;
  }
  const paths = profilePaths({ profileRoot, invocation: state.invocation });
  const serverEnv = herdrServerEnv(env, paths);
  const bin = resolveHerdrBinary({ env }).bin;

  const stopped = herdr(["server", "stop"], { bin, env: serverEnv });
  // ASKED AGAIN, because "the request was accepted" is not "the server is gone", and this command's
  // entire job is the second one.
  const after = serverAnswer(herdr(["pane", "list"], { bin, env: serverEnv }));
  clearProfileOwner(profileRoot, state.invocation);

  process.stderr.write(
    `herdr-aify: invocation ${state.invocation} — ` +
      `${stopped.ok ? "stop accepted" : `stop refused (${stopped.error})`}, ` +
      `${goneWords(after)}\n`,
  );
  return after === "not-running" ? 0 : 1;
}

/** What a post-stop read says, in words. Three answers, because "could not tell" is not "still up". */
function goneWords(answer) {
  if (answer === "not-running") return "confirmed gone";
  if (answer === "serving") return "STILL ANSWERING";
  return "could not confirm it is gone";
}

/**
 * Is there a terminal for the Herdr TUI to take over?
 *
 * A TUI NEEDS A REAL CONSOLE. Attached to a pipe it draws escape sequences into whatever is reading,
 * and there is no keyboard to serve — so a scripted or piped run stays headless and says so. BOTH
 * streams, because Herdr draws to one and reads from the other, and a run with only stdin redirected
 * is exactly the case that would half-work.
 */
/**
 * Which of the two things this command is, decided by the operator's own split.
 *
 * `herdr-aify`      an isolated Herdr with WRAPPER SUPPORT and no daemon — for resident sessions, a
 *                   place `claude-aify` runs, claims its pane, and is restored into.
 * `herdr-aify env`  the same, plus a dedicated aify-env in the first space — for managed work.
 *
 * IT USED TO IGNORE THE WORD ENTIRELY. The operator's very first use was `herdr-aify env`, and the
 * argument reached nothing: every launch started a daemon, including the launches meant to be a
 * plain Herdr. A command that silently discards an argument is worse than one that refuses it,
 * because the operator has no way to learn it was never read.
 */
export function modeFor(argv = []) {
  const words = argv.filter(arg => !String(arg).startsWith("-"));
  if (words.length === 0) return { ok: true, withEnv: false };
  if (words.length === 1 && words[0] === "env") return { ok: true, withEnv: true };
  return { ok: false, error: `unknown argument ${JSON.stringify(words.join(" "))}; expected "env" or nothing` };
}

export function shouldAttach({ argv = [], io = process } = {}) {
  if (argv.includes("--no-attach")) return false;
  return Boolean(io.stdout?.isTTY && io.stdin?.isTTY);
}

/**
 * The instance this run drives. Injectable for ONE reason, and it is the reason this file exists in
 * its current shape: the defect that reached the operator twice was a call site, not a helper. A
 * `HerdrAifyInstance` built inline means no test can ask whether `run` actually attaches anything —
 * which is exactly the question that went unasked while the command shipped with no TUI at all.
 */
const realInstance = ({ profileRoot, invocation }) => new HerdrAifyInstance({ profileRoot, invocation, processes, clock });

/**
 * Plain `herdr-aify`: attach to the ONE Herdr this host keeps, starting it only if nothing answers.
 *
 * NO INVOCATION, NO OWNER, NO INSTANCE CONTEXT. All of that exists to admit a dedicated aify-env and
 * to guarantee a new invocation cannot adopt an old one's workers. This mode starts no daemon and is
 * SUPPOSED to come back to the same session, so minting any of it would be machinery working against
 * the feature — which is exactly what it did: a throwaway profile per launch meant nothing was ever
 * restored, and a resident agent was left running with nothing pointing at it.
 *
 * CLOSING THE TUI DETACHES. The server stays up with its spaces and its agents, the way an ordinary
 * Herdr does, and `herdr-aify --stop` is how an operator ends it on purpose.
 */
async function runResident({ profileRoot, env, attaching, bin }) {
  const paths = residentPaths({ profileRoot });
  const ready = await ensureResident({
    paths, env, bin, cli: herdr, io: fs, sleep: clock.sleep,
    spawn: (command, argv, options) => processes.spawn(command, argv, options),
  });
  if (!ready.ok) {
    process.stderr.write(`herdr-aify: could not start the resident herdr: ${ready.error}\n`);
    return 1;
  }

  // THE PLUGIN, LINKED ONCE INTO THIS PROFILE. It is what makes a `claude-aify` pane claim itself and
  // come back after a restart, which is the whole reason this mode carries wrapper support.
  const serverEnv = serverEnvFor(env, paths);
  if (ready.started) {
    const linked = herdr(["plugin", "link", fileURLToPath(new URL("../herdr-plugin/", import.meta.url))], { bin, env: serverEnv });
    if (!linked.ok) process.stderr.write(`herdr-aify: WARNING the aify plugin did not link (${linked.error}); panes will not be restored\n`);
  }

  process.stderr.write(`herdr-aify: herdr socket ${paths.socketPath}\n`);
  process.stderr.write(
    ready.started
      ? "herdr-aify: started this host's herdr — resident sessions only, no aify-env\n"
      : "herdr-aify: attached to this host's herdr, with the spaces it already had\n",
  );

  if (!attaching) {
    process.stderr.write("herdr-aify: no terminal to attach to; the herdr keeps running. Use --stop to end it\n");
    return 0;
  }
  process.stderr.write("herdr-aify: leaving the session DETACHES — your agents keep running; --stop ends them\n");
  const client = processes.attach(bin, [], { env: serverEnv });
  await client.exited;
  process.stderr.write("herdr-aify: detached; the herdr and its agents are still running\n");
  return 0;
}

async function run({
  profileRoot = defaultProfileRoot(),
  env = process.env,
  attaching = shouldAttach({ argv: process.argv.slice(2) }),
  makeInstance = realInstance,
  withEnv = false,
  // INJECTABLE FOR ONE REASON, and it is a defect this change caused: the plain branch starts a REAL
  // Herdr, so any test calling `run()` without naming a mode started one. Three were left running by
  // the suite before this was sealed.
  resident = runResident,
} = {}) {
  // THE BINARY FIRST, because both modes need it and a missing one must name every place it looked
  // rather than surfacing as ENOENT from whichever call happened to be first.
  if (!withEnv) {
    const binary = resolveHerdrBinary({ env });
    if (!binary.ok) {
      process.stderr.write(`herdr-aify: ${binary.why}\n`);
      return 1;
    }
    return resident({ profileRoot, env, attaching, bin: binary.bin });
  }
  // A SECOND LAUNCH REPORTS AND STOPS. Without this the incumbent's owner pointer is simply
  // overwritten: two dedicated Herdrs and two dedicated aify-envs run with no refusal anywhere, and
  // when the SECOND one exits it clears the pointer, leaving the first unowned. `profileOwnerState`
  // existed for exactly this question and nothing asked it.
  // `owned`, NOT `live`. This read `incumbent?.live` — a field `profileOwnerState` has never
  // returned — so it was always undefined and the refusal never fired once: a second `herdr-aify`
  // started a second Herdr and a second dedicated aify-env, and clobbered the first one's owner
  // pointer on the way. Caught by running two of them, not by a test, which is why there is now a
  // test that drives this function's REAL return shape.
  const incumbent = await profileOwnerState(profileRoot);
  if (alreadyRunning(incumbent)) {
    process.stderr.write(
      `herdr-aify: an instance is already running here (invocation ${incumbent.invocation}${
        incumbent.pid ? `, pid ${incumbent.pid}` : ""
      }).\n  Close it first, or run --status to see what this host holds.\n`,
    );
    return 3;
  }

  const invocation = randomUUID();
  const instance = makeInstance({ profileRoot, invocation });

  // THE OWNER LISTENS BEFORE THE DAEMON EXISTS. aify-env refuses to start a dedicated instance until
  // something answers a fresh nonce on the private endpoint, so an owner started afterwards would be
  // a race this loses on a fast machine.
  const owner = new HerdrOwner(instance.context);
  await owner.listen();
  writeProfileOwner(profileRoot, { invocation, ownerEndpoint: instance.context.ownerEndpoint, pid: process.pid });

  let closing = false;
  const shutdown = async code => {
    if (closing) return;
    closing = true;
    // TEARDOWN MUST NOT DIE HALFWAY. A rejection anywhere in here used to surface as an unhandled
    // rejection that killed the process mid-shutdown, leaving whatever `stop()` had not yet reached.
    let line = "herdr-aify: stopped";
    try {
      line = teardownLine(await instance.stop({ env, herdrBin: resolveHerdrBinary({ env }).bin }));
    } catch (err) {
      line = `herdr-aify: teardown failed: ${err?.message || err}`;
    }
    try {
      await owner.close();
      clearProfileOwner(profileRoot, invocation);
    } catch {
      // The owner pointer is a courtesy to the next launch; failing to clear it must not stop exit.
    }
    process.stderr.write(`${line}\n`);
    // RETURNS THE CODE RATHER THAN EXITING, and the exit is the entry point's job. Calling
    // `process.exit` here ended whatever process was hosting this run: under `node --test` it killed
    // the runner mid-file, and the two tests that drive this function were reported as never having
    // existed -- a plan line of `1..4` for a file holding six. A teardown that cannot be observed
    // without ending the observer is a teardown nothing can test, which is how it stayed unexamined.
    return code;
  };

  // SIGBREAK IS THE WINDOWS ONE AND WAS MISSING. Node never emits SIGTERM on Windows, so a console
  // Ctrl-Break — and several of the ways a terminal ends a command — reached no handler at all.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(signal, () => {
        // A SIGNAL STILL ENDS THE PROCESS, because nothing is waiting on this path to return: the
        // operator asked for it to stop. The teardown runs first, then the exit.
        shutdown(0)
          .then(code => process.exit(code))
          .catch(() => process.exit(1));
      });
    } catch {
      // A platform that does not know a signal name is not a reason to fail the launch.
    }
  }

  // RESOLVED BEFORE ANYTHING IS SPAWNED, and refused with the search path when it is missing. The
  // first real run of this command died on `spawn herdr ENOENT` against a host where Herdr was
  // installed and working: its directory is on neither the user nor the system PATH, so the bare
  // name resolves only for shells Herdr itself started. `ENOENT` told the operator nothing.
  const binary = resolveHerdrBinary({ env });
  if (!binary.ok) {
    process.stderr.write(`herdr-aify: ${binary.why}\n`);
    return await shutdown(1);
  }

  const started = await instance.start({
    env,
    herdrBin: binary.bin,
    withEnv,
    // THE PLUGIN GOES INTO THIS PROFILE, not the operator's. Without it a `claude-aify` started in
    // here claims no pane and nothing restores it -- which is the whole point of the plain mode.
    pluginDir: fileURLToPath(new URL("../herdr-plugin/", import.meta.url)),
  });
  if (!started.ok) {
    process.stderr.write(`herdr-aify: could not start (${started.phase}): ${started.error}\n`);
    return await shutdown(1);
  }

  process.stderr.write(`herdr-aify: invocation ${invocation}\n`);
  process.stderr.write(`herdr-aify: herdr socket ${instance.profile.socketPath}\n`);
  // SAY WHICH OF THE TWO THIS IS. The modes differ in the one thing the operator cares about — whether
  // managed work can run here — and a line that read the same for both would leave them guessing.
  process.stderr.write(
    withEnv
      ? `herdr-aify: aify-env in ${started.paneId} — managed work runs here\n`
      : "herdr-aify: no aify-env — resident sessions only; claude-aify panes are claimed and restored\n",
  );
  if (instance.pluginLinked === false) {
    process.stderr.write(`herdr-aify: WARNING the aify plugin did not link (${instance.pluginError}); panes will not be restored\n`);
  }

  // ATTACH, WHICH IS THE THING AN OPERATOR ACTUALLY WANTED. `herdr server` is headless; a bare
  // `herdr` is the client that draws it. Without this the command printed these three lines in front
  // of a terminal where nothing opened and Ctrl-C did nothing, because the launcher owned a console
  // it was not using and the TUI that should have owned it was never started.
  if (attaching) {
    process.stderr.write("herdr-aify: attaching — leaving the Herdr session ends this instance\n");
    const client = instance.attachTui({ env, herdrBin: binary.bin });
    // EITHER END CAN GO FIRST. Leaving the session is the ordinary exit; the server going away (a
    // `--stop` from another shell, a crash) must not leave a client drawing a dead session.
    await Promise.race([client.exited, instance.whenServerExits()]);
    try {
      client.kill();
    } catch {
      // Already gone, which is the common case: the client exits when its server does.
    }
    return await shutdown(0);
  }

  // NO TERMINAL TO ATTACH TO, so this stays headless and says so. THE COMMAND'S LIFETIME IS STILL THE
  // INSTANCE'S LIFETIME, in both directions: waiting on a promise that never resolves held only one
  // of them, and stopping the server from elsewhere left this process alive in front of nothing.
  process.stderr.write("herdr-aify: no terminal to attach to; running headless. Close this command to end all of it\n");
  await instance.whenServerExits();
  process.stderr.write("herdr-aify: the dedicated herdr exited" + String.fromCharCode(10));
  return await shutdown(0);
}

const USAGE = [
  "usage: herdr-aify [env] [--no-attach]",
  "       herdr-aify --status | --stop | --prune",
  "",
  "  herdr-aify        this host's herdr, for RESIDENT sessions. claude-aify panes claim themselves",
  "                    here and come back after a restart. Leaving it DETACHES; agents keep running.",
  "  herdr-aify env    a fresh instance with a dedicated aify-env, for MANAGED work. Dies with the",
  "                    command, and never adopts a previous instance's workers.",
  "  --stop            end whichever of the two this host is running.",
].join(String.fromCharCode(10)) + String.fromCharCode(10);

async function main(argv) {
  if (argv.includes("--status")) {
    process.stdout.write(`${JSON.stringify(invocationsOnDisk(), null, 1)}\n`);
    return 0;
  }
  if (argv.includes("--stop")) return stopRecorded();
  if (argv.includes("--prune")) return pruneInvocations();
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  // AN ARGUMENT THE COMMAND DOES NOT UNDERSTAND IS REFUSED, NOT DISCARDED. `env` reached nothing for
  // this feature's whole life while being the operator's very first use of it.
  const mode = modeFor(argv);
  if (!mode.ok) {
    process.stderr.write(`herdr-aify: ${mode.error}\n${USAGE}`);
    return 2;
  }
  return run({ withEnv: mode.withEnv });
}

export { run, processes, stopRecorded };

if (isMainModule(import.meta.url)) {
  // A THROW FROM `run()` USED TO SURFACE AS A RAW UNHANDLED REJECTION. The reachable window is real:
  // `owner.listen()` rejects on a bind failure, and `writeProfileOwner` can throw — both AFTER the
  // owner is serving and BEFORE the signal handlers exist, which is the worst moment to exit with a
  // stack trace and no teardown.
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(err => {
      process.stderr.write(`herdr-aify: ${err?.message || err}\n`);
      process.exitCode = 1;
    });
}
