// The owner of one integrated Herdr invocation: who authorizes its daemon, and who says "already running".
//
// WHY AN OWNER EXISTS AT ALL. `aify-env`'s dedicated bootstrap refuses to start until something
// answers a fresh challenge on the private owner endpoint. That is deliberate and it is the reason
// a dedicated daemon cannot be started by accident: a `/health` response proves a daemon is alive,
// it cannot prove anybody owns it, so the daemon demands an answer only its launcher can give.
//
// THE CHALLENGE IS ECHOED, NOT ACKNOWLEDGED. The daemon sends a nonce and requires every field back
// beside `accepted: true`. A listener that replies "ok" to everything fails, and so does one
// replaying an older exchange. This is the one place the two repos speak a wire format to each
// other, so the reply is assembled from the received challenge rather than rebuilt from local state
// — rebuilding is how the two sides drift and how a mismatch becomes a two-second timeout with no
// reason attached.
//
// ONE OWNER PER PROFILE, AND WHY IT IS NOT THE PIPE. Every invocation mints a fresh UUID, so two
// launchers get different endpoint names and would never collide on them; a per-invocation endpoint
// therefore cannot answer "is one already running". The profile pointer below is what answers it,
// and it is proven live by challenging the endpoint it names rather than by trusting that the file
// exists — a file outlives the process that wrote it, which is precisely the case worth catching.
//
// A SECOND LAUNCH REPORTS AND STOPS. It does not take over, stop, attach to or replace the incumbent.
// Takeover here would mean one invocation reaping another's workers, which is the failure the whole
// dedicated-instance design exists to prevent.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Longer than a challenge can legitimately be; a peer sending more is not speaking this protocol. */
const MAX_LINE = 4096;

/** The daemon's own timeout is 2s, so a slower answer is already too late to be useful. */
const PROBE_TIMEOUT_MS = 2000;

const AUTHORIZE = "authorize-env";
const PROBE = "probe-owner";

/** Where a profile records which invocation currently owns it. Never inside an invocation root. */
export function profileOwnerFile(profileRoot) {
  return path.join(path.resolve(profileRoot), "owner.json");
}

/**
 * Decide whether a challenge may be accepted.
 *
 * PURE, so the refusals can be tested without a socket — and there are more refusals than
 * acceptances, which is the half that never gets exercised when a check is welded to its transport.
 */
export function challengeVerdict(challenge, { invocation, scope }) {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) return "malformed";
  if (challenge.version !== 1) return "unsupported-version";
  if (challenge.operation !== AUTHORIZE && challenge.operation !== PROBE) return "unknown-operation";
  if (typeof challenge.nonce !== "string" || !challenge.nonce) return "missing-nonce";
  // A challenge naming another invocation is a stranger's, and answering it would let this owner
  // vouch for a daemon it does not own.
  if (challenge.invocation !== invocation || challenge.scope !== scope) return "not-mine";
  return "accept";
}

/** The exact reply shape the daemon validates: every field it sent, plus the verdict. */
export function replyTo(challenge, verdict) {
  return { ...challenge, accepted: verdict === "accept" };
}

/**
 * The live owner of one invocation.
 *
 * A CLASS because it has identity (one invocation), state (a listening server) and a lifetime that
 * something else has to end. The decisions it makes are the pure functions above.
 */
export class HerdrOwner {
  #server = null;
  #seen = [];
  #open = new Set();

  /**
   * Takes the instance context itself, and spells the endpoint the way that context spells it.
   *
   * THE GUARD IS NOT DECORATION. An earlier draft read `endpoint`, which the context does not have,
   * so it received undefined — and `server.listen(undefined)` does not fail, it binds an arbitrary
   * TCP port. The owner then looked healthy while the daemon's challenge reached a pipe nobody was
   * serving, and every refusal test still passed, because a broken endpoint and a genuine refusal
   * are the same observation from the client side. Fail closed on the field being absent.
   */
  constructor({ invocation, scope, ownerEndpoint }, { netModule = net } = {}) {
    if (typeof ownerEndpoint !== "string" || !ownerEndpoint) throw new Error("herdr_owner: ownerEndpoint required");
    if (typeof invocation !== "string" || typeof scope !== "string") throw new Error("herdr_owner: identity required");
    this.invocation = invocation;
    this.scope = scope;
    this.ownerEndpoint = ownerEndpoint;
    this.net = netModule;
  }

  /** Every challenge this owner judged, for a test to assert on and for a receipt to record. */
  get exchanges() { return [...this.#seen]; }

  async listen() {
    this.#server = this.net.createServer(socket => this.#serve(socket));
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.ownerEndpoint, () => { this.#server.off("error", reject); resolve(); });
    });
    return this;
  }

  #serve(socket) {
    let text = "";
    this.#open.add(socket);
    socket.on("close", () => this.#open.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      text += chunk;
      if (text.length > MAX_LINE) return socket.destroy();
      if (!text.includes("\n")) return;
      let challenge = null;
      try { challenge = JSON.parse(text.split("\n")[0]); } catch { return socket.destroy(); }
      const verdict = challengeVerdict(challenge, { invocation: this.invocation, scope: this.scope });
      this.#seen.push({ operation: challenge?.operation ?? null, verdict });
      // A refusal is ANSWERED rather than dropped. Dropping it turns a wrong invocation into the
      // daemon's two-second timeout, which reads identically to a crashed owner.
      socket.end(`${JSON.stringify(replyTo(challenge, verdict))}\n`);
    });
  }

  async close() {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    // A pipe the peer has not closed yet would otherwise hold `close()` open indefinitely.
    for (const socket of this.#open) socket.destroy();
    this.#open.clear();
    await new Promise(resolve => server.close(resolve));
  }
}

/**
 * Ask an endpoint to prove a live owner is behind it.
 *
 * NOT "DOES SOMETHING LISTEN". On Windows a named pipe with no server refuses instantly, but a
 * half-dead peer can accept a connection and never answer — so liveness is the echoed nonce, and
 * anything else (refused, silent, malformed, not-mine) is reported as no live owner.
 */
export async function probeOwner(endpoint, { invocation, scope }, { netModule = net, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const challenge = { version: 1, operation: PROBE, invocation, scope, nonce: randomUUID() };
  return new Promise(resolve => {
    let text = "";
    let done = false;
    const socket = netModule.connect(endpoint);
    const finish = alive => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(challenge)}\n`));
    socket.on("data", chunk => {
      text += chunk;
      if (text.length > MAX_LINE) return finish(false);
      if (!text.includes("\n")) return;
      try {
        const reply = JSON.parse(text.split("\n")[0]);
        finish(reply.accepted === true && Object.keys(challenge).every(key => reply[key] === challenge[key]));
      } catch { finish(false); }
    });
  });
}

/**
 * Is this profile already owned by a live invocation?
 *
 * A MISSING OR UNREADABLE POINTER IS NOT AN ANSWER EITHER WAY, and it is reported as free — the
 * pointer is written by the launcher that owns the profile, so its absence means no launcher got
 * far enough to own it. A pointer naming a dead owner is stale and also free; the launcher that
 * finds it replaces it rather than refusing forever on a file nobody cleaned up.
 */
export async function profileOwnerState(profileRoot, { io = fs, netModule = net, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let pointer = null;
  try { pointer = JSON.parse(io.readFileSync(profileOwnerFile(profileRoot), "utf8")); } catch { return { owned: false, reason: "no-pointer" }; }
  const invocation = pointer?.invocation;
  const endpoint = pointer?.ownerEndpoint;
  if (pointer?.version !== 1 || typeof invocation !== "string" || typeof endpoint !== "string") {
    return { owned: false, reason: "unreadable-pointer" };
  }
  const scope = `herdr-${invocation}`;
  const alive = await probeOwner(endpoint, { invocation, scope }, { netModule, timeoutMs });
  return alive
    ? { owned: true, reason: "live-owner", invocation, ownerEndpoint: endpoint }
    : { owned: false, reason: "stale-pointer", invocation };
}

/** Claim the profile for this invocation. Written only after its owner endpoint is already serving. */
export function writeProfileOwner(profileRoot, { invocation, ownerEndpoint, pid }, { io = fs } = {}) {
  const file = profileOwnerFile(profileRoot);
  io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  io.writeFileSync(file, `${JSON.stringify({ version: 1, invocation, ownerEndpoint, pid })}\n`, { mode: 0o600 });
  return file;
}

/**
 * Release the profile, but only if this invocation still holds it.
 *
 * READ BEFORE DELETE, because a launcher that lost a race and exited `already_running` must never
 * remove the winner's pointer on its way out. The check is not atomic against a concurrent writer
 * and is not claimed to be; it removes the ordinary case where a loser erases the winner.
 */
export function clearProfileOwner(profileRoot, invocation, { io = fs } = {}) {
  const file = profileOwnerFile(profileRoot);
  try {
    const pointer = JSON.parse(io.readFileSync(file, "utf8"));
    if (pointer?.invocation !== invocation) return false;
  } catch { return false; }
  try { io.rmSync(file); } catch { return false; }
  return true;
}
