// Pure capability material. Randomness is supplied by the launcher; importing this module does no work.
import { createHash } from 'node:crypto';

/** Exactly 32 random bytes in; an unpadded bearer token and the verifier of its UTF-8 text out. */
export function codexAuthMaterial(randomBytes) {
  if (!Buffer.isBuffer(randomBytes) || randomBytes.length !== 32) {
    throw new Error('Codex auth needs exactly 32 random bytes in a Buffer');
  }
  const token = randomBytes.toString('base64url');
  return { token, sha256: createHash('sha256').update(token, 'utf8').digest('hex') };
}
