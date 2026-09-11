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

import path from "node:path";

import { buildInstanceContext, dedicatedDaemonEnv, instancePaths, writeInstanceContext } from "./herdr-instance.mjs";
import { agentEnv, dedicatedEnvArgv, herdrServerEnv, profilePaths } from "./herdr-profile.mjs";

/** How long to wait for the dedicated Herdr to answer on its own socket before giving up. */
export const READY_TIMEOUT_MS = 20000;
const POLL_MS = 250;

/** The phases, in order, so a failure can say which one it died in rather than just that it died. */
export const PHASES = Object.freeze(["mint", "serve", "ready", "space", "env"]);

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
   * Bring the instance up, in the only order that is safe.
   *
   * MINT BEFORE SERVE. The context file is what makes the invocation single-use; writing it after
   * the server existed would leave a window in which a second launcher could mint the same one.
   *
   * SPACE BEFORE ENV. The env must land in a pane of THIS Herdr, so the pane has to exist first —
   * and if it cannot be made, nothing has been started that would need collecting.
   */
  async start({ env = {}, herdrBin = "herdr", envBin = "aify-env", io } = {}) {
    writeInstanceContext(this.#context, io ? { io } : undefined);

    const serverEnv = herdrServerEnv(env, this.#profile);
    this.#server = this.#processes.spawn(herdrBin, ["server"], { env: serverEnv, detached: false });
    if (!this.#server || this.#server.failed) return this.#failed("serve", this.#server?.error || "herdr server did not start");

    const ready = await this.#waitForReady({ herdrBin, serverEnv });
    if (!ready.ok) return this.#failed("ready", ready.error);

    const space = this.#processes.run(herdrBin, ["workspace", "create", "--label", "aify-env"], { env: serverEnv });
    if (!space.ok) return this.#failed("space", space.error || "could not create the first space");

    // The daemon gets the ISOLATED env's advertisement rules but NOT the agents' environment: it is
    // Herdr's own child and is supposed to live and die with this instance.
    const daemonEnv = dedicatedDaemonEnv(serverEnv, this.#context);
    const started = this.#processes.run(
      herdrBin,
      ["pane", "run", space.paneId, envBin, ...dedicatedEnvArgv(this.contextFile)],
      { env: daemonEnv },
    );
    if (!started.ok) return this.#failed("env", started.error || "could not start the dedicated aify-env");

    return Object.freeze({ ok: true, phase: null, error: null, paneId: space.paneId });
  }

  /** The environment an agent inside this instance must get: this instance's isolation undone. */
  agentEnvironment(base, host) {
    return agentEnv(base, { host });
  }

  /**
   * Take the whole tree down, and say what it actually managed to do.
   *
   * IDEMPOTENT, because both a signal handler and an ordinary exit reach it, and a second teardown
   * that killed "whatever is there now" would be reaching for processes this instance never owned.
   */
  async stop({ env = {}, herdrBin = "herdr" } = {}) {
    if (this.#stopped) return Object.freeze({ stopped: true, already: true, serverStopped: false, killed: false });
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
    return Object.freeze({ stopped: true, already: false, serverStopped: Boolean(stopped.ok), killed });
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
