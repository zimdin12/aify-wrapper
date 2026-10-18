// A service's key, read from the credential file its registry entry names (`credentialRef`), under aify-env's rules:
// `~/.aify/credentials/<ref>`, the key plus exactly one trailing newline, strict UTF-8, no control character, no
// surrounding whitespace, at most 4096 bytes (aify-env lib/credential-store.mjs `decodeCredential`, lib/credential-fs.mjs).
// A file that breaks a rule gives no key rather than a salvaged one: the key travels as a header, and two readers that
// "both guessed the same way" are not in agreement. Held to aify-env's decoder by tests/credential-file-is-aify-envs.test.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_CREDENTIAL_BYTES = 4096;

/** PURE. The key in a credential file's bytes, or "" for any file aify-env would refuse. */
export function credentialFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAX_CREDENTIAL_BYTES) return "";
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
  if (!text.endsWith("\n")) return "";
  const value = text.slice(0, -1);
  // eslint-disable-next-line no-control-regex
  if (value === "" || /[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value) return "";
  return value;
}

/**
 * The key `credentialRef` names under `home`, or "" when there is none or it is unusable. Never rejects.
 * ASYNC, so a slow read cannot hold the event loop a caller's deadline timer runs on.
 */
export async function readCredential(credentialRef, { home = os.homedir(), readFile = fs.promises.readFile } = {}) {
  if (!credentialRef) return "";
  try {
    return credentialFromBytes(await readFile(path.join(home, ".aify", "credentials", credentialRef)));
  } catch {
    return "";
  }
}
