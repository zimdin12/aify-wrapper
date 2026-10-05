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
// A SECOND LAUNCH NEVER TAKES OVER. Since 0.8.6 it JOINS a running incumbent (attaches its TUI) and
// otherwise refuses; it never stops or replaces one. Takeover here would mean one invocation reaping
// another's workers, which is the failure the whole dedicated-instance design exists to prevent.
// And since leaving detaches, a pointer whose owner is gone is the ORDINARY state of a running
// instance: the launcher asks the instance's own socket (`incumbentAction` in bin/herdr-aify.mjs).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Windows' pipe namespace, as Node accepts it for IPC. Everything else is a filesystem path. */
const NAMED_PIPE = /^\\\\[.?]\\pipe\\/i;

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
  constructor({ invocation, scope, ownerEndpoint }, { netModule = net, io = fs } = {}) {
    if (typeof ownerEndpoint !== "string" || !ownerEndpoint) throw new Error("herdr_owner: ownerEndpoint required");
    if (typeof invocation !== "string" || typeof scope !== "string") throw new Error("herdr_owner: identity required");
    this.invocation = invocation;
    this.scope = scope;
    this.ownerEndpoint = ownerEndpoint;
    this.net = netModule;
    this.io = io;
  }

  /** Every challenge this owner judged, for a test to assert on and for a receipt to record. */
  get exchanges() { return [...this.#seen]; }

  /**
   * THE SOCKET'S DIRECTORY IS MADE HERE, because the launcher listens before `start()` mints the
   * invocation -- the daemon it spawns challenges this endpoint, so the owner has to come first. A
   * named pipe needs no directory, which is why that order held on Windows; a unix socket bound in a
   * directory that does not exist fails with EACCES. Private, because on POSIX that directory is
   * what keeps other users off the socket.
   */
  async listen() {
    if (!NAMED_PIPE.test(this.ownerEndpoint)) {
      this.io.mkdirSync(path.dirname(this.ownerEndpoint), { recursive: true, mode: 0o700 });
    }
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
 * far enough to own it. A pointer naming a dead owner is "stale-pointer", which says only that the
 * LAUNCHER is gone: since 0.8.6 its instance normally runs on, so a caller asks that instance's
 * socket before treating the profile as free.
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

/** Does a process with this pid exist? EPERM is a process this user may not signal, which still exists. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Hold this profile's start lock from deciding what `herdr-aify env` does until its instance is up: `{ ok, release }`,
 * or `{ ok: false, holder }` naming the pid of the launch that holds it.
 *
 * WHY. Deciding reads the pointer and starting writes it, so two launches at once both read "nothing recorded" and
 * both started. The losing instance was left with no pointer, so nothing could join or stop it, and since 0.8.6 it
 * no longer dies with its terminal (review of 0.8.6). `wx` makes the claim atomic. A lock whose holder is gone is
 * taken over, once; a holder that is alive, or a pid reused by an unrelated process, refuses rather than guesses.
 */
export function claimStart(profileRoot, { io = fs, pid = process.pid, alive = pidAlive } = {}) {
  const file = path.join(profileRoot, "env-starting.lock");
  io.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      io.writeFileSync(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      const release = () => {
        try {
          if (Number(io.readFileSync(file, "utf8")) === pid) io.rmSync(file);
        } catch {
          // Already gone; nothing of ours to remove.
        }
      };
      return { ok: true, release };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    let holder = null;
    try { holder = Number(io.readFileSync(file, "utf8")); } catch { continue; }
    // NO PID YET IS A CLAIM BEING WRITTEN, not an abandoned one: refused, never removed.
    if (!Number.isInteger(holder) || holder <= 0 || alive(holder)) return { ok: false, holder, file };
    // "changed": another launch replaced it, so the next attempt reads that one instead.
    if (reclaimDeadLock(file, holder, { io }) === "busy") return { ok: false, holder: null, file: `${file}.reclaim` };
  }
  return { ok: false, holder: null, file };
}

/**
 * Remove a start lock whose holder is dead -- but only the lock that holder wrote.
 *
 * A VERDICT READ EARLIER IS NOT THE FILE THERE NOW. Two launches both read dead holder 111; the second removed it and
 * wrote its own live 222; the first, acting on its cached verdict, removed 222 and wrote 333, and both claims came back
 * ok (review of e51b83e, R1). So a removal holds `<lock>.reclaim`, created with `wx`, and re-reads the lock under it:
 * a lock is only ever removed here, so while that file is held the lock cannot change between the read and the rm.
 * A reclaim lock that is already there refuses ("busy") rather than waits or is taken over: taking it over would be
 * this same race one level up. Its holder holds it for one read and one rm.
 * @returns {"removed" | "changed" | "busy"}
 */
function reclaimDeadLock(file, deadHolder, { io }) {
  const guard = `${file}.reclaim`;
  try {
    io.writeFileSync(guard, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err?.code === "EEXIST") return "busy";
    throw err;
  }
  try {
    let now = null;
    try { now = Number(io.readFileSync(file, "utf8")); } catch { return "removed"; }
    if (now !== deadHolder) return "changed";
    io.rmSync(file);
    return "removed";
  } finally {
    try { io.rmSync(guard); } catch { /* nothing else removes it; a failure here leaves it for the operator, named */ }
  }
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
