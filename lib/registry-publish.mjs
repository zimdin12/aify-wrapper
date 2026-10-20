// Publishing a registry: one cooperating writer at a time, and a result that says whether it landed.
//
// THE LOCK IS FOR COOPERATING WRITERS ONLY. `<registry>.lock` is created exclusively and held from the reread to the
// readback. A writer that ignores it -- today aify-dashboard's register, which writes a temp file and renames it --
// is not excluded by it, and is named as such rather than advertised as covered (format freeze, item 6). The CAS on
// the reread is what catches such a writer when it lands between this connect's first read and its write.
//
// A HELD LOCK IS NEVER STOLEN. A stale one, left by a killed connect, is named with its holder and left for the
// operator, because a lock old enough to look dead and a slow writer look the same from here.
//
// THE COMMIT BOUNDARY IS THE READBACK, not the rename's return. `committed` when the file now hashes to the
// candidate, `not-committed` when it still hashes to what was there, `unknown` otherwise. The caller deletes newly
// staged credentials only on `not-committed`: on the other two they may be what the registry now names.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const COMMITTED = "committed";
export const NOT_COMMITTED = "not-committed";
export const UNKNOWN = "unknown";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The registry's bytes and their hash; an absent file is empty bytes, an ordinary first install. */
export function snapshot(registryPath, io = fs) {
  let bytes = Buffer.alloc(0);
  try {
    bytes = io.readFileSync(registryPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { bytes, hash: sha256(bytes) };
}

/** Take `<registry>.lock`, waiting at most `waitMs`. Returns the token to release with, or throws naming the holder. */
export async function acquireLock(registryPath, { waitMs = 10_000, pollMs = 100, io = fs } = {}) {
  const lockPath = `${registryPath}.lock`;
  const token = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: randomBytes(8).toString("hex") });
  const deadline = Date.now() + waitMs;
  io.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = io.openSync(lockPath, "wx");
      try {
        io.writeSync(fd, token);
      } finally {
        io.closeSync(fd);
      }
      return { lockPath, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) {
      let holder = "unreadable";
      try {
        holder = io.readFileSync(lockPath, "utf8");
      } catch {
        // Gone between the open and this read; the next connect will find it free.
      }
      throw new Error(`${lockPath} is held by ${holder}; it is never taken over. Remove it only if that holder is gone.`);
    }
    await sleep(pollMs);
  }
}

/** Release only a lock this connect holds: a lock whose text is not our token belongs to someone else. */
export function releaseLock({ lockPath, token }, io = fs) {
  try {
    if (io.readFileSync(lockPath, "utf8") === token) io.unlinkSync(lockPath);
  } catch {
    // Already gone. Nothing of ours to release.
  }
}

/**
 * Replace the registry with `candidateText` if it still hashes to `expectedHash`, under the lock, and classify.
 *
 * @returns {Promise<{result: string, detail: string}>}
 */
export async function publish(registryPath, candidateText, expectedHash, { io = fs, waitMs } = {}) {
  const candidate = Buffer.from(candidateText, "utf8");
  const lock = await acquireLock(registryPath, { io, waitMs });
  try {
    const before = snapshot(registryPath, io);
    if (before.hash !== expectedHash) {
      return { result: NOT_COMMITTED, detail: "the registry changed after connect read it; nothing was written" };
    }
    const temp = `${registryPath}.connect-${randomBytes(6).toString("hex")}.tmp`;
    try {
      io.writeFileSync(temp, candidate);
      io.renameSync(temp, registryPath);
    } catch (error) {
      try { io.rmSync(temp, { force: true }); } catch { /* the rename may have consumed it */ }
      return classify(registryPath, candidate, before.hash, io, `the write failed: ${error.message}`);
    }
    return classify(registryPath, candidate, before.hash, io, "");
  } finally {
    releaseLock(lock, io);
  }
}

function classify(registryPath, candidate, beforeHash, io, why) {
  let now;
  try {
    now = snapshot(registryPath, io).hash;
  } catch (error) {
    return { result: UNKNOWN, detail: `the registry could not be read back: ${error.message}` };
  }
  if (now === sha256(candidate)) return { result: COMMITTED, detail: why };
  if (now === beforeHash) return { result: NOT_COMMITTED, detail: why || "the registry still holds what it held" };
  return { result: UNKNOWN, detail: `${why ? `${why}; ` : ""}the registry holds neither the old nor the new text` };
}
