// A credential file written the way aify-env's secure writer leaves one: private to the account the tests run as.
// lib/credential-custody.mjs refuses anything else, and a temp directory's inherited ACL grants groups (measured on
// this host: Administrators, SYSTEM and a sandbox group), so a plain write would be refused for its custody.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** What custody reads on Windows (the owner, and the system root icacls is found by); a sealed test env must carry it. */
export function ownerEnv(env = process.env) {
  return Object.fromEntries(["USERNAME", "USERDOMAIN", "SystemRoot"].filter((name) => env[name]).map((name) => [name, env[name]]));
}

/** Make `file` readable by its owner alone. */
export function makePrivate(file) {
  if (process.platform === "win32") {
    const owner = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${owner}:F`], { stdio: "ignore", windowsHide: true });
  } else {
    fs.chmodSync(file, 0o600);
  }
  return file;
}

/** Write `key` as `<home>/.aify/credentials/<ref>`, private, and return the file. */
export function writePrivateCredential(home, ref, key) {
  const dir = path.join(home, ".aify", "credentials");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ref);
  fs.writeFileSync(file, `${key}\n`);
  return makePrivate(file);
}
