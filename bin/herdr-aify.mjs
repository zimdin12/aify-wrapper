#!/usr/bin/env node
// herdr-aify — an integrated Herdr that belongs to one invocation and dies with it.
//
//   herdr-aify            start an isolated Herdr with a dedicated aify-env in its first space
//   herdr-aify --status   what this host's invocations left behind
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

import { isMainModule } from "../lib/main-module.mjs";
import { herdr } from "../lib/herdr-cli.mjs";
import { HerdrOwner, clearProfileOwner, profileOwnerState, writeProfileOwner } from "../lib/herdr-owner.mjs";
import { HerdrAifyInstance } from "../lib/herdr-supervisor.mjs";

/** Every invocation of every herdr-aify on this host lives under here. */
export function defaultProfileRoot({ home = os.homedir() } = {}) {
  return path.join(home, ".aify", "herdr");
}

/** The real process control the supervisor is given. Injected there; concrete only here. */
const processes = {
  spawn(command, argv, { env }) {
    // DETACHED ON POSIX, so the server leads a process GROUP and the backstop can reach its panes.
    // Without it `process.kill(-pid)` names a group that does not exist and fails with ESRCH every
    // time — the documented last resort could never once have fired. On Windows the group concept
    // does not apply and `taskkill /T` walks the tree instead.
    const detached = process.platform !== "win32";
    const child = spawn(command, argv, { env, stdio: "ignore", windowsHide: true, detached });
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
  run(command, argv, { env }) {
    const result = herdr(argv, { bin: command, env });
    // `workspace create` answers with the new space, and the first pane in it is where the env goes.
    const paneId = result.json?.result?.root_pane?.pane_id || result.json?.result?.pane?.pane_id || null;
    return { ok: result.ok, error: result.error, paneId };
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

async function run({ profileRoot = defaultProfileRoot(), env = process.env } = {}) {
  // A SECOND LAUNCH REPORTS AND STOPS. Without this the incumbent's owner pointer is simply
  // overwritten: two dedicated Herdrs and two dedicated aify-envs run with no refusal anywhere, and
  // when the SECOND one exits it clears the pointer, leaving the first unowned. `profileOwnerState`
  // existed for exactly this question and nothing asked it.
  const incumbent = await profileOwnerState(profileRoot);
  if (incumbent?.live) {
    process.stderr.write(
      `herdr-aify: an instance is already running here (invocation ${incumbent.invocation}${
        incumbent.pid ? `, pid ${incumbent.pid}` : ""
      }).\n  Close it first, or run --status to see what this host holds.\n`,
    );
    return 3;
  }

  const invocation = randomUUID();
  const instance = new HerdrAifyInstance({ profileRoot, invocation, processes, clock });

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
      const result = await instance.stop({ env });
      line =
        `herdr-aify: stopped (server ${result.serverStopped ? "stopped cleanly" : "did not stop"}` +
        `${result.killed ? ", tree killed" : ""}` +
        // Reported separately from the request, because a stop that was ACCEPTED is not a server
        // that is gone, and this command's whole promise is about what is actually gone.
        `${result.confirmedGone ? ", confirmed gone" : ", STILL ANSWERING - check herdr-aify --status"})`;
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
    process.exit(code);
  };

  // SIGBREAK IS THE WINDOWS ONE AND WAS MISSING. Node never emits SIGTERM on Windows, so a console
  // Ctrl-Break — and several of the ways a terminal ends a command — reached no handler at all.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(signal, () => {
        shutdown(0).catch(() => process.exit(1));
      });
    } catch {
      // A platform that does not know a signal name is not a reason to fail the launch.
    }
  }

  const started = await instance.start({ env });
  if (!started.ok) {
    process.stderr.write(`herdr-aify: could not start (${started.phase}): ${started.error}\n`);
    await shutdown(1);
    return 1;
  }

  process.stderr.write(`herdr-aify: invocation ${invocation}\n`);
  process.stderr.write(`herdr-aify: herdr socket ${instance.profile.socketPath}\n`);
  process.stderr.write(`herdr-aify: aify-env in ${started.paneId}; close this command to end all of it\n`);

  // The command's lifetime IS the instance's lifetime, which is the whole contract. Nothing else
  // here keeps the process alive, so the wait is explicit rather than an accident of an open handle.
  await new Promise(() => {});
  return 0;
}

async function main(argv) {
  if (argv.includes("--status")) {
    process.stdout.write(`${JSON.stringify(invocationsOnDisk(), null, 1)}\n`);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("usage: herdr-aify [--status]\n");
    return 0;
  }
  return run();
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
