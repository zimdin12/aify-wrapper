// Publishing a registry: one cooperating writer at a time, and a result that says whether it landed.
//
// Connect and aify-dashboard's register share FileLock, held from the reread through the readback. A writer
// ignoring it is not excluded; the CAS catches a change between connect's initial read and its held reread.
// A dead/reused holder is recovered only by FileLock's existing positive evidence, never by lock age.
// Unknown or unreadable holders remain held. The takeover/put-back window requires a token check immediately
// before the registry rename, not just a CAS (lib/file-lock.mjs).
//
// THE COMMIT BOUNDARY IS THE READBACK, not the rename's return. `committed` when the file now hashes to the
// candidate, `not-committed` when it still hashes to what was there, `unknown` otherwise. The caller deletes newly
// staged credentials only on `not-committed`: on the other two they may be what the registry now names.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { FileLock } from "./file-lock.mjs";

export const COMMITTED = "committed";
export const NOT_COMMITTED = "not-committed";
export const UNKNOWN = "unknown";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

/** Replace under FileLock, preserving the async public result while the held callback stays synchronous. */
export async function publish(registryPath, candidateText, expectedHash, { io = fs, waitMs = 10_000, probe } = {}) {
  const candidate = Buffer.from(candidateText, "utf8");
  const lock = new FileLock({ path: `${registryPath}.lock`, waitMs, staleMs: Infinity, unreadableMs: Infinity, io, probe,
    busy: (file, holder) => new Error(`${file} is held by ${holder}; unreadable or unverified holders require manual repair. Remove the lock only after proving its holder is gone.`) });
  return lock.hold((stillHeld) => {
    const before = snapshot(registryPath, io);
    if (before.hash !== expectedHash) {
      return { result: NOT_COMMITTED, detail: "the registry changed after connect read it; nothing was written" };
    }
    const temp = `${registryPath}.connect-${randomBytes(6).toString("hex")}.tmp`;
    try {
      io.writeFileSync(temp, candidate);
      if (!stillHeld()) {
        try { io.rmSync(temp, { force: true }); } catch { /* only this publisher's staged file */ }
        return { result: NOT_COMMITTED, detail: "registry lock ownership was lost before rename; nothing was written" };
      }
      io.renameSync(temp, registryPath);
    } catch (error) {
      try { io.rmSync(temp, { force: true }); } catch { /* the rename may have consumed it */ }
      return classify(registryPath, candidate, before.hash, io, `the write failed: ${error.message}`);
    }
    return classify(registryPath, candidate, before.hash, io, "");
  });
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
