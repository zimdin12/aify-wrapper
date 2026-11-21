import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialRefProblem, decodeCredential } from "aify-env/client/credentials";

export function credentialFromBytes(bytes) {
  return Buffer.isBuffer(bytes) ? decodeCredential(bytes).value : "";
}

/** Turn-start only: preserve the async, launch-checked read without a per-turn ACL subprocess. */
export async function readCredential(ref, { home = os.homedir() } = {}) {
  if (credentialRefProblem(ref)) return "";
  const file = path.join(home, ".aify", "credentials", ref);
  try {
    const real = await fs.promises.realpath(file);
    const parent = await fs.promises.realpath(path.dirname(file));
    if (path.basename(real) !== ref || path.dirname(real) !== parent) return "";
    return credentialFromBytes(await fs.promises.readFile(file));
  } catch {
    return "";
  }
}
