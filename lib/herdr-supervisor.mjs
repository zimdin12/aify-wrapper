// One `herdr-aify` invocation: an isolated Herdr, a dedicated aify-env in its first space, and the
// promise that closing the command closes all of it.
//
// THE PROMISE IS THE TEARDOWN, so that is what this class is built around. The operator's ruling:
// "Ending herdr-aify ends that Herdr instance, its env, and its workers. A new invocation starts
// without resurrecting the previous workers."
//
// HOW THE TEARDOWN ACTUALLY REACHES THE WORKERS, and it is not a process-tree walk. The dedicated
// aify-env runs in a PANE of this Herdr and its workers are its own children, so stopping this
// Herdr server ends the panes, which ends the env, which ends the workers. The tree kill below is a
// BACKSTOP for a server that will not stop, not the mechanism.
//
// IT IS NOT A WINDOWS JOB OBJECT. A real kill-on-close Job needs a native addon, and this package
// has no native dependency; that is a deliberate limit and it is stated rather than implied. What it
// buys instead is the no-resurrection guarantee, which is enforced by the filesystem: a fresh UUID
// per invocation, and a daemon that refuses a context whose receipts already exist. So a hard kill
// of this launcher can leave processes behind -- but it can never let the NEXT invocation adopt
// them, which is the half the operator asked for.
//
// EVERY PROCESS OPERATION IS INJECTED, so the sequence and the teardown can be judged by tests
// without starting a Herdr, a daemon, or an agent.

import fs from "node:fs";
import path from "node:path";

import { buildInstanceContext, dedicatedDaemonEnv, instancePaths, writeInstanceContext } from "./herdr-instance.mjs";
import { dedicatedEnvArgv, herdrServerEnv, profilePaths } from "./herdr-profile.mjs";

/** How long to wait for the dedicated Herdr to answer on its own socket before giving up. */
export const READY_TIMEOUT_MS = 20000;

/** How long the dedicated daemon gets to publish its readiness receipt. */
export const DAEMON_TIMEOUT_MS = 30000;
const POLL_MS = 250;

/** The phases, in order, so a failure can say which one it died in rather than just that it died. */
export const PHASES = Object.freeze(["mint", "serve", "ready", "space", "env", "daemon"]);

export class HerdrAifyInstance {
  #profileRoot;
  #invocation;
  #platform;
  #processes;
  #clock;
  #context;
  #paths;
  #profile;
  #server = null;
  #serving = false;
  #stopped = false;

  /**
   * @param processes  { spawn, run, kill } — starting the server, calling the herdr CLI, last resort.
   * @param clock      { now, sleep } — so a readiness wait is a test that finishes, not one that waits.
   */
  constructor({ profileRoot, invocation, platform = process.platform, processes, clock }) {
    this.#profileRoot = profileRoot;
    this.#invocation = invocation;
    this.#platform = platform;
    this.#processes = processes;
    this.#clock = clock;
    this.#profile = profilePaths({ profileRoot, invocation, platform });
    this.#paths = instancePaths({ profileRoot, invocation, platform });
    this.#context = buildInstanceContext({ profileRoot, invocation, profileRef: "integrated", platform });
  }

  get invocation() {
    return this.#invocation;
  }

  get context() {
    return this.#context;
  }

  get profile() {
    return this.#profile;
  }

  get contextFile() {
    return path.join(this.#context.root, "instance.json");
  }

  /**
   * Resolves when the dedicated Herdr server goes away.
   *
   * THE COMMAND'S LIFETIME IS THE INSTANCE'S LIFETIME, and that has to hold in BOTH directions. It
   * only held in one: closing the command ended the server, but ending the server -- with
   * `herdr-aify --stop` from another shell, or a crash -- left the launcher sitting on a promise
   * that never resolves, in front of nothing.
   */
  whenServerExits() {
    const child = this.#server?.child;
    if (!child) return new Promise(() => {});
    if (this.#server.exited) return Promise.resolve();
    return new Promise(resolve => child.once("exit", () => resolve()));
  }

  /**
   * Bring the instance up, in the only order that is safe.
   *
   * MINT BEFORE SERVE. The context file is what makes the invocation single-use; writing it after
   * the server existed would leave a window in which a second launcher could mint the same one.
   *
   * SPACE BEFORE ENV. The env must land in a pane of THIS Herdr, so the pane has to exist first —
   * and if it cannot be made, nothing has been started that would need collecting.
   */
  async start({ env = {}, herdrBin = "herdr", envBin = "aify-env", io = fs } = {}) {
    writeInstanceContext(this.#context, { io });

    // THE DAEMON'S ENVIRONMENT GOES ON THE SERVER, NOT ON THE CLI CALL. `pane run` TYPES a command
    // into a shell that already exists, so environment handed to the `herdr` process never reaches
    // it. Measured: the dedicated aify-env refused with `instance_context: advertisement must be
    // explicitly disabled` because AIFY_ADVERTISE=0 was set on the CLI invocation and not on the
    // pane. A dedicated Herdr's whole subtree should never advertise anyway, so this is where it
    // belonged.
    const serverEnv = dedicatedDaemonEnv(herdrServerEnv(env, this.#profile), this.#context);
    this.#server = this.#processes.spawn(herdrBin, ["server"], { env: serverEnv });

    // WAITED FOR, NOT READ SYNCHRONOUSLY. `child.on("error")` fires on a LATER tick, so reading a
    // `failed` flag straight after spawn always saw false — and for a missing binary the child emits
    // `error` and `close` but never `exit`, so the readiness loop's own early-out never fired either.
    // A missing `herdr` was therefore reported as "not ready within 20000ms", twenty seconds after
    // the fact, when the truth was that it is not installed.
    const launched = await this.#settled(this.#server);
    if (!launched.ok) return this.#failed("serve", launched.error);
    this.#serving = true;

    const ready = await this.#waitForReady({ herdrBin, serverEnv });
    if (!ready.ok) return this.#failed("ready", ready.error);

    const space = this.#processes.run(herdrBin, ["workspace", "create", "--label", "aify-env"], { env: serverEnv });
    if (!space.ok) return this.#failed("space", space.error || "could not create the first space");

    // The daemon gets the ISOLATED env's advertisement rules: it is Herdr's own child and is meant
    // to live and die with this instance.
    const started = this.#processes.run(
      herdrBin,
      ["pane", "run", space.paneId, envBin, ...dedicatedEnvArgv(this.contextFile)],
      { env: serverEnv },
    );
    if (!started.ok) return this.#failed("env", started.error || "could not start the dedicated aify-env");

    // THE DAEMON'S OWN RECEIPT, because `pane run` only says a command was TYPED into a pane. It
    // returns ok when `aify-env` is not on PATH, when the daemon refuses the context, and when the
    // owner challenge fails — and the launcher then told the operator the env was running and blocked
    // for ever in front of an empty pane. `ready.json` is published by the daemon at readiness and is
    // the only thing that means it actually booted.
    const booted = await this.#waitForDaemon({ io });
    if (!booted.ok) return this.#failed("daemon", booted.error);

    return Object.freeze({ ok: true, phase: null, error: null, paneId: space.paneId });
  }

  /**
   * Take the whole tree down, and say what it actually managed to do.
   *
   * IDEMPOTENT, because both a signal handler and an ordinary exit reach it, and a second teardown
   * that killed "whatever is there now" would be reaching for processes this instance never owned.
   */
  async stop({ env = {}, herdrBin = "herdr" } = {}) {
    if (this.#stopped) return Object.freeze({ stopped: true, already: true, everServed: this.#serving, alreadyGone: false, serverStopped: false, killed: false, confirmedGone: true });
    // NOTHING TO TEAR DOWN is its own answer, not a failed stop. A server that never started reported
    // "did not stop, confirmed gone" -- two clauses that contradict each other, in front of an
    // operator whose real problem was one line above.
    if (!this.#serving) {
      this.#stopped = true;
      return Object.freeze({ stopped: true, already: false, everServed: false, alreadyGone: false, serverStopped: false, killed: false, confirmedGone: true });
    }
    // THE SERVER MAY HAVE GONE FIRST, and that is the ORDINARY case rather than an edge: a
    // `herdr-aify --stop` from another shell ends the server, the launcher wakes BECAUSE its child
    // exited, and then asks a socket nobody is listening on to stop. The request fails because there
    // is nothing to ask, and the line printed "server did not stop, confirmed gone" -- two clauses
    // contradicting each other, describing a teardown that went exactly to plan.
    //
    // It also reached for the backstop kill with the pid of a process that has already exited, which
    // on Windows is a recycled-pid hazard: nothing about that pid is ours any more.
    if (this.#server?.exited) {
      this.#stopped = true;
      return Object.freeze({ stopped: true, already: false, everServed: true, alreadyGone: true, serverStopped: false, killed: false, confirmedGone: true });
    }
    this.#stopped = true;
    const serverEnv = herdrServerEnv(env, this.#profile);

    // THE MECHANISM: stopping this Herdr ends its panes, which ends the env, which ends its workers.
    const stopped = this.#processes.run(herdrBin, ["server", "stop"], { env: serverEnv });

    // THE BACKSTOP, and only if the mechanism did not work. Killing unconditionally would race a
    // clean shutdown that was already collecting the workers properly.
    let killed = false;
    if (!stopped.ok && this.#server?.pid) {
      killed = Boolean(this.#processes.kill(this.#server.pid));
    }

    // VERIFIED, because `server stop` returning 0 says the REQUEST was accepted and nothing more.
    // The whole contract of this command is that closing it ends the Herdr, the dedicated env and
    // its workers, and the line that reported on that contract measured none of it.
    const gone = this.#processes.run(herdrBin, ["pane", "list"], { env: serverEnv });
    return Object.freeze({
      stopped: true,
      already: false,
      everServed: true,
      alreadyGone: false,
      serverStopped: Boolean(stopped.ok),
      killed,
      // The server answering AFTER a stop means it is still up; a refusal is the evidence we want.
      confirmedGone: !gone.ok,
    });
  }

  /**
   * Whether a spawned child actually started, waited out rather than sampled.
   *
   * The handle may carry a `started` promise (the real implementation resolves it on Node's `spawn`
   * event and rejects it on `error`). A handle without one falls back to its flags, so a test double
   * stays simple.
   */
  async #settled(handle) {
    if (!handle) return { ok: false, error: "herdr server did not start" };
    if (handle.started && typeof handle.started.then === "function") {
      try {
        await handle.started;
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    }
    if (handle.failed) return { ok: false, error: handle.error || "herdr server did not start" };
    return { ok: true, error: null };
  }

  /** Poll for the receipt the dedicated daemon publishes when it is genuinely up. */
  async #waitForDaemon({ io }) {
    const deadline = this.#clock.now() + DAEMON_TIMEOUT_MS;
    while (this.#clock.now() < deadline) {
      try {
        if (io.existsSync(this.#paths.readinessEndpoint)) return { ok: true, error: null };
      } catch {
        // An unreadable path is not a receipt; keep waiting until the deadline says otherwise.
      }
      await this.#clock.sleep(POLL_MS);
    }
    return {
      ok: false,
      error: `the dedicated aify-env published no readiness receipt within ${DAEMON_TIMEOUT_MS}ms ` +
        `(${this.#paths.readinessEndpoint}); it may not be on PATH, or it refused the instance context`,
    };
  }

  async #waitForReady({ herdrBin, serverEnv }) {
    const deadline = this.#clock.now() + READY_TIMEOUT_MS;
    let last = "never answered";
    while (this.#clock.now() < deadline) {
      const probe = this.#processes.run(herdrBin, ["pane", "list"], { env: serverEnv });
      if (probe.ok) return { ok: true, error: null };
      last = probe.error || "not ready";
      // A server that has already exited will never become ready, so waiting out the clock would
      // turn a fast, explainable failure into a twenty-second one.
      if (this.#server?.exited) return { ok: false, error: `herdr server exited before it was ready: ${last}` };
      await this.#clock.sleep(POLL_MS);
    }
    return { ok: false, error: `herdr server was not ready within ${READY_TIMEOUT_MS}ms: ${last}` };
  }

  #failed(phase, error) {
    return Object.freeze({ ok: false, phase, error: String(error), paneId: null });
  }
}
