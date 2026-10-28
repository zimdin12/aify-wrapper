// A service's key, read from the credential file its registry entry names (`credentialRef`), under aify-env's rules:
// `~/.aify/credentials/<ref>`, the key plus exactly one trailing newline, strict UTF-8, no control character, no
// surrounding whitespace, at most 4096 bytes (aify-env lib/credential-store.mjs `decodeCredential`, lib/credential-fs.mjs).
// A file that breaks a rule gives no key rather than a salvaged one: the key travels as a header, and two readers that
// "both guessed the same way" are not in agreement. Held to aify-env's decoder by
// tests/machine-id-and-credential-file-are-aify-envs.test.js. A file reached through a link, or readable by more than
// its owner, is refused before its bytes are read (credential-custody.mjs), as aify-comms' resolver refuses it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { custodyProblemFor } from "./credential-custody.mjs";

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
 * Whether `target` is itself, not reached through a link: its real path is the same name in the real form of the
 * directory asked for. BOTH SIDES RESOLVED, as comms' keyForEndpoint does, because on Windows a temp path arrives in
 * 8.3 form (`ADMINI~1`) and the resolved one does not.
 */
async function pathIsWhatWasAskedFor(target, realpath) {
  try {
    const real = await realpath(target);
    return path.basename(real) === path.basename(target) && path.dirname(real) === (await realpath(path.dirname(target)));
  } catch {
    return false;
  }
}

/**
 * The key `credentialRef` names under `home`, and why there is none: `{ key, refused }`, with `refused` "" exactly when
 * there is a key. Never rejects. A file reached through a link, or one more than its owner can read, is refused as
 * aify-env refuses it (credential-custody.mjs), and its bytes are never read.
 * ASYNC, so a slow read cannot hold the event loop a caller's deadline timer runs on.
 */
export async function credentialRead(credentialRef, {
  home = os.homedir(), readFile = fs.promises.readFile, realpath = fs.promises.realpath, custody = custodyProblemFor,
} = {}) {
  if (!credentialRef) return { key: "", refused: "no credentialRef" };
  const file = path.join(home, ".aify", "credentials", credentialRef);
  if (!(await pathIsWhatWasAskedFor(file, realpath))) return { key: "", refused: `${credentialRef} is missing or reached through a link` };
  const problem = await custody(file);
  if (problem) return { key: "", refused: `${credentialRef} ${problem}` };
  try {
    const key = credentialFromBytes(await readFile(file));
    return { key, refused: key ? "" : `${credentialRef} does not hold a key aify-env would accept` };
  } catch (failure) {
    return { key: "", refused: `${credentialRef} could not be read: ${failure?.code || failure}` };
  }
}

/** The key alone, or "" when there is none or it is refused (credentialRead). Never rejects. */
export async function readCredential(credentialRef, options) {
  return (await credentialRead(credentialRef, options)).key;
}
