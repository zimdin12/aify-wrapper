#!/usr/bin/env node
// herdr-aify — this host's aify-flavoured Herdr, in two modes with two lifetimes.
//
//   herdr-aify            THE ONE THIS HOST KEEPS. Wrapper support, no daemon, for RESIDENT sessions:
//                         leaving it DETACHES and the next launch comes back to the same spaces and
//                         the same agents, exactly as an ordinary Herdr does.
//   herdr-aify env        A dedicated Herdr with its own aify-env in the first space, for MANAGED work.
//                         Leaving it DETACHES too (0.8.6), and a second `herdr-aify env` joins the
//                         running one; `herdr-aify env --stop` ends it. A NEW one, started once the old
//                         one has ended, never adopts the old one's workers -- that is what the
//                         invocation machinery is for, and why the two modes do not share a profile.
//   herdr-aify --status   what this host's invocations left behind
//   herdr-aify --stop     end this host's resident herdr; `herdr-aify env --stop` ends the env instance, even if
//                         its launcher was killed without a signal
//   herdr-aify --prune    delete what dead invocations left behind
//   herdr-aify --no-attach  run headless instead of taking this terminal over with the Herdr TUI
//
// WHAT IT IS FOR, in the operator's words: "a dedicated Herdr instance with the actual aify-env
// process in its own space. Ending herdr-aify ends that Herdr instance, its env, and its workers. A
// new invocation starts without resurrecting the previous workers. Ordinary Herdr remains separate."
// AND THEN, 2026-10-05: closing a terminal should not end managed work; "make them work in same manner",
// so leaving detaches and only `herdr-aify env --stop` ends that Herdr, its env and its workers.
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
import { HerdrOwner, claimStart, clearProfileOwner, profileOwnerState, writeProfileOwner } from "../lib/herdr-owner.mjs";
import { stopRecorded, stopTarget } from "../lib/herdr-stop.mjs";
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
    // `independent` IS FOR A SERVER THAT OUTLIVES THE COMMAND, which both modes' servers do since 0.8.6
    // (leaving the session detaches). The launcher tells the operator "your agents keep running" as it
    // exits, and a plain child makes
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
 * What `herdr-aify env` does about the instance this profile records: "start" a new one, "join" the running one, or
 * "refuse". PURE, so the decision is a test rather than a launch.
 *
 * THE RECORDED INSTANCE'S OWN SOCKET DECIDES, not its launcher. Leaving the session detaches, so the launcher that
 * wrote the pointer is normally gone while its instance runs on; reading "no live owner" as "free" would start a
 * second aify-env on top of it. `answer` is `serverAnswer` of that socket. A socket that cannot tell refuses, and
 * so does a live launcher whose server is not serving (it is starting or stopping).
 */
export function incumbentAction(state, answer) {
  if (!state?.invocation) return "start";
  if (answer === "serving") return "join";
  if (answer === "not-running" && !alreadyRunning(state)) return "start";
  return "refuse";
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

/**
 * The flag a herdr-SHAPED command means, or null.
 *
 * WHY. An operator holding `herdr` in their hands reaches for `herdr-aify server stop`, and an
 * operator who has just read `herdr server stop` reaches for `stop`. Both were refused with a usage
 * line while the server they meant kept running (measured 2026-09-16: `herdr server stop` cannot see
 * this profile's socket at all, so the refusal was the only answer they got from either command).
 * The verbs are herdr's own spelling, which is the whole point of accepting them.
 */
export function flagForSubcommand(argv = []) {
  const words = argv.filter(arg => !String(arg).startsWith("-")).map(arg => String(arg));
  const said = words[0] === "server" ? words.slice(1) : words;
  if (said.length !== 1) return null;
  return { stop: "--stop", status: "--status", prune: "--prune" }[said[0]] ?? null;
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
 * SIGBREAK IS THE WINDOWS ONE AND WAS MISSING. Node never emits SIGTERM on Windows, so a console
 * Ctrl-Break — and several of the ways a terminal ends a command — reached no handler at all.
 */
function installSignalHandler(handler) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(signal, handler);
    } catch {
      // A platform that does not know a signal name is not a reason to fail the launch.
    }
  }
}

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
  // The herdr CLI that asks a recorded instance whether it is still serving; injected for the same reason.
  cli = herdr,
  // Where a signal's handler is installed, and how it ends the process: injected so what a signal does before and
  // after the instance is up is a test, not a Ctrl-C.
  onSignal = installSignalHandler,
  exit = code => process.exit(code),
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
  // RESOLVED BEFORE ANYTHING IS SPAWNED, and refused with the search path when it is missing. The
  // first real run of this command died on `spawn herdr ENOENT` against a host where Herdr was
  // installed and working: its directory is on neither the user nor the system PATH, so the bare
  // name resolves only for shells Herdr itself started. `ENOENT` told the operator nothing.
  const binary = resolveHerdrBinary({ env });
  if (!binary.ok) {
    process.stderr.write(`herdr-aify: ${binary.why}\n`);
    return 1;
  }

  // A SECOND LAUNCH NEVER STARTS A SECOND INSTANCE. Two dedicated Herdrs mean two dedicated aify-envs, and the
  // later one supersedes the earlier and reaps its workers. The recorded instance is asked through its OWN
  // socket, because its launcher is gone once the operator has detached (see `incumbentAction`). Decided and
  // started under the profile's start lock, so two launches at once cannot both read "nothing recorded".
  const claim = claimStart(profileRoot);
  if (!claim.ok) {
    process.stderr.write(
      `herdr-aify: another \`herdr-aify env\` (pid ${claim.holder > 0 ? claim.holder : "not yet written"}) is starting this host's instance; nothing was started.\n`
        + `  Run \`herdr-aify env\` again once it is up to attach to it. A lock left by a crash is ${claim.file}\n`,
    );
    return 3;
  }
  const incumbent = await profileOwnerState(profileRoot);
  let answer = null;
  if (incumbent?.invocation) {
    const recorded = profilePaths({ profileRoot, invocation: incumbent.invocation });
    answer = serverAnswer(cli(["pane", "list"], { bin: binary.bin, env: herdrServerEnv(env, recorded) }));
  }
  const action = incumbentAction(incumbent, answer);
  if (action !== "start") claim.release();
  if (action === "join") {
    return joinRunning({
      instance: makeInstance({ profileRoot, invocation: incumbent.invocation }),
      invocation: incumbent.invocation, env, attaching, bin: binary.bin,
    });
  }
  if (action === "refuse") {
    process.stderr.write(
      answer === "unknown"
        ? `herdr-aify: could not tell whether instance ${incumbent.invocation} is running; nothing was started.\n`
          + "  Try again, or `herdr-aify env --stop` to end it.\n"
        : `herdr-aify: instance ${incumbent.invocation} has a live launcher and is not serving yet (starting or stopping); `
          + "nothing was started. Try again in a moment.\n",
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
    claim.release();
    process.stderr.write(`${line}\n`);
    // RETURNS THE CODE RATHER THAN EXITING, and the exit is the entry point's job. Calling
    // `process.exit` here ended whatever process was hosting this run: under `node --test` it killed
    // the runner mid-file, and the two tests that drive this function were reported as never having
    // existed -- a plan line of `1..4` for a file holding six. A teardown that cannot be observed
    // without ending the observer is a teardown nothing can test, which is how it stayed unexamined.
    return code;
  };

  // LEAVING A RUNNING INSTANCE: this launcher goes, the instance stays. The owner endpoint closes with it,
  // which aify-env does not need after its start; the pointer stays, naming the invocation a later
  // `herdr-aify env` joins and `herdr-aify env --stop` ends.
  let up = false;
  const detach = async code => {
    if (closing) return code;
    closing = true;
    try {
      await owner.close();
    } catch {
      // Nothing to release beyond this process, which is leaving anyway.
    }
    process.stderr.write("herdr-aify: detached; aify-env and its agents are still running. `herdr-aify env --stop` ends them\n");
    return code;
  };

  // A SIGNAL ENDS THIS PROCESS. Before the instance is up it takes the half-started instance with it; once it is
  // up, a closed terminal or Ctrl-Break DETACHES, as leaving the session does.
  onSignal(() => {
    (up ? detach(0) : shutdown(0))
      .then(code => exit(code))
      .catch(() => exit(1));
  });

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
  up = true;
  // Recorded and serving: a launch from here on joins it, so the lock has done its job.
  claim.release();

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
  // LEAVING DETACHES, as it does for the resident (operator, 2026-10-05: "make them work in same manner";
  // `--stop` is the only end). It used to end the instance, so closing a terminal ended aify-env and every
  // managed worker. Only the server going away, a `herdr-aify env --stop` from another shell or a crash,
  // still ends this run as a teardown.
  if (attaching) {
    process.stderr.write("herdr-aify: attaching — leaving the Herdr session DETACHES; `herdr-aify env --stop` ends it\n");
    const client = instance.attachTui({ env, herdrBin: binary.bin });
    const ended = await Promise.race([client.exited.then(() => "left"), instance.whenServerExits().then(() => "server-gone")]);
    if (ended === "left") return await detach(0);
    try {
      client.kill();
    } catch {
      // Already gone, which is the common case: the client exits when its server does.
    }
    return await shutdown(0);
  }

  // NO TERMINAL TO ATTACH TO: started, and left running, as the resident is.
  process.stderr.write("herdr-aify: no terminal to attach to; `herdr-aify env` in a terminal attaches to it\n");
  return await detach(0);
}

/**
 * A second `herdr-aify env` while one is running JOINS it. Starting another would start a second aify-env, which
 * supersedes the one serving this machine and reaps its workers; refusing was right while leaving ended the instance,
 * and is wrong now that leaving detaches.
 */
async function joinRunning({ instance, invocation, env, attaching, bin }) {
  if (!attaching) {
    process.stderr.write(`herdr-aify: instance ${invocation} is already running; \`herdr-aify env\` in a terminal attaches, \`herdr-aify env --stop\` ends it\n`);
    return 0;
  }
  process.stderr.write(`herdr-aify: attaching to the running instance ${invocation} — leaving DETACHES; \`herdr-aify env --stop\` ends it\n`);
  const client = instance.attachTui({ env, herdrBin: bin });
  await client.exited;
  // WHAT THIS LAUNCH KNOWS, and no more: it joined a herdr that was serving, and left it. Whether aify-env is still
  // up in w1:p1 is that pane's to show; nor can it tell its own leaving from an `env --stop` elsewhere.
  process.stderr.write(`herdr-aify: left instance ${invocation}; \`herdr-aify env\` attaches again, \`herdr-aify env --stop\` ends it\n`);
  return 0;
}

const USAGE = [
  "usage: herdr-aify [env] [--no-attach]",
  "       herdr-aify --status | --stop | --prune   (or: status, stop, prune -- `server stop` too)",
  "",
  "  herdr-aify        this host's herdr, for RESIDENT sessions. claude-aify panes claim themselves",
  "                    here and come back after a restart. Leaving it DETACHES; agents keep running.",
  "  herdr-aify env    a dedicated Herdr with its own aify-env, for MANAGED work. Leaving it DETACHES;",
  "                    a second `herdr-aify env` attaches to it. A new one never adopts an ended one's workers.",
  "  --stop            end this host's herdr; `herdr-aify env --stop` ends the env instance. `herdr server stop` cannot:",
  "                    this profile keeps its own socket, which is what isolates it from your herdr.",
].join(String.fromCharCode(10)) + String.fromCharCode(10);

async function main(argv) {
  // `stop`, `server stop`, `status`, `prune`: the spelling herdr itself uses, answered rather than refused.
  const asFlag = flagForSubcommand(argv);
  if (asFlag) argv = [...argv, asFlag];
  if (argv.includes("--status")) {
    process.stdout.write(`${JSON.stringify(invocationsOnDisk(), null, 1)}\n`);
    return 0;
  }
  if (argv.includes("--stop")) return stopRecorded({ profileRoot: defaultProfileRoot(), target: stopTarget(argv) });
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

export { run, processes };

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
