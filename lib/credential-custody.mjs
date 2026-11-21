// Wrapper-owned custody policy for the folders where session files are written.
// aify-env owns credential-store file custody; this module does not read a key.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

//: Principals that are a GROUP or a broad authority rather than one account.
const BROAD_PRINCIPALS = new Set([
  "everyone", "users", "authenticated users", "interactive", "network", "batch", "service",
  "terminal server user", "remote desktop users", "guests", "guest",
]);

//: Allowed beside the owner, and only this. A service account genuinely needs SYSTEM on hosts where
//: the daemon runs as one. `Administrators` is deliberately NOT here: whether a principal COULD
//: escalate to read the file is a different question from whether the file is currently granted to
//: more accounts than its owner, and on a machine with several administrators the second answer is
//: the operator's to make rather than this check's to assume.
const ALWAYS_ALLOWED = new Set(["system"]);

/** `DOMAIN\\user` -> `user`, lowercased. */
function aclPrincipalLeaf(principal) {
  const text = String(principal ?? "").trim();
  const cut = text.lastIndexOf("\\");
  return (cut === -1 ? text : text.slice(cut + 1)).trim().toLowerCase();
}

/**
 * The access-control entries in `icacls` output.
 *
 * THE PATH IS REMOVED BY NAME, not guessed at. The first line is `<path> <principal>:(flags)` with no
 * unambiguous delimiter: a Windows path contains backslashes, so a domain-qualified principal cannot
 * be found by "the last backslash", and a path may contain spaces, so not by "the last space" either.
 * With an unqualified principal -- `Everyone` being the obvious one -- the last backslash falls
 * inside the PATH and the whole line parses as one principal named after the directory.
 */
function parseIcaclsAces(text, { path = "" } = {}) {
  const out = [];
  const target = String(path ?? "");
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^Successfully processed|^Failed processing/i.test(line)) continue;
    if (target && line.startsWith(target)) line = line.slice(target.length).trim();
    const match = line.match(/([^:]+):((?:\([^)]*\))+)\s*$/);
    if (!match) continue;
    let principal = match[1].trim();
    const flags = match[2];
    if (!target) {
      const domainCut = principal.lastIndexOf("\\");
      const before = domainCut === -1 ? principal : principal.slice(0, domainCut);
      const space = before.lastIndexOf(" ");
      if (space !== -1) principal = principal.slice(space + 1).trim();
    }
    if (!principal) continue;
    out.push({ principal, leaf: aclPrincipalLeaf(principal), flags, inherited: flags.includes("(I)") });
  }
  return out;
}

/**
 * Who, besides the owner, this file is granted to.
 *
 * AN EMPTY PARSE IS A REFUSAL, not "no grants, therefore private". It is far more likely to mean the
 * output changed shape or the command failed, and reading a secret on the strength of a parser that
 * understood nothing is exactly the false negative this exists to avoid.
 */
function aclProblem(aces, { owner = "" } = {}) {
  const entries = Array.isArray(aces) ? aces : [];
  if (entries.length === 0) {
    return "no access-control entries could be read, so the permissions are unknown";
  }
  const ownerLeaf = aclPrincipalLeaf(owner);
  const offenders = [];
  for (const ace of entries) {
    const leaf = String(ace?.leaf ?? aclPrincipalLeaf(ace?.principal));
    if (leaf && leaf === ownerLeaf) continue;
    if (ALWAYS_ALLOWED.has(leaf)) continue;
    if (BROAD_PRINCIPALS.has(leaf)) {
      offenders.push(`${ace.principal} (a group)`);
      continue;
    }
    offenders.push(String(ace.principal));
  }
  return offenders.length ? `readable by ${offenders.join(", ")}` : "";
}

/** The account this process runs as, in the form `icacls` prints. */
function currentWindowsOwner(env = process.env) {
  const user = String(env.USERNAME || "").trim();
  const domain = String(env.USERDOMAIN || "").trim();
  if (!user) return "";
  return domain ? `${domain}\\${user}` : user;
}

/**
 * Where icacls is, from the system root Windows names in the environment, or "" when it names none. BY ITS SYSTEM
 * PATH, not by name: a launch's PATH need not hold System32 (a sealed test env's does not), and a bare name that fails
 * to resolve reads as "permissions unknown", refusing every key on that launch. No root is guessed: without one the ACL
 * cannot be read, and the check refuses.
 */
export function icaclsPath(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || "";
  return root ? path.join(root, "System32", "icacls.exe") : "";
}

/** `icacls <path>`, or its own failure output. Never receives or prints the key. */
async function readAcl(target, run, env) {
  const icacls = icaclsPath(env);
  if (!icacls) return "";
  try {
    return String((await run(icacls, [target], { encoding: "utf8", timeout: 5000, windowsHide: true }))?.stdout || "");
  } catch (failure) {
    // Its OWN output on failure, not a throw: an unreadable ACL must reach `aclProblem`, which treats
    // "no entries could be read" as a refusal rather than as an absence of problems.
    return String(failure?.stdout || "");
  }
}

/**
 * PURE. What is wrong with a FOLDER's custody: the same grants rule as a credential's, for a real directory. The
 * folder that per-launch files holding keys are written into (session-folder.mjs) must be its owner's alone, or
 * anyone it grants could read a key or rewrite what a session is about to load.
 *
 * @returns {string} a reason, or "" when the folder is private to this process
 */
export function folderCustodyProblem({ platform = process.platform, stats = null, aclText = "", owner = "", uid = -1, aclPath = "" } = {}) {
  if (!stats) return "no folder information";
  if (stats.isSymbolicLink()) return "is a link rather than a folder";
  if (!stats.isDirectory()) return "is not a folder";
  if (platform === "win32") return aclProblem(parseIcaclsAces(aclText, { path: aclPath }), { owner });
  if (uid >= 0 && typeof stats.uid === "number" && stats.uid !== uid) return `is owned by uid ${stats.uid}, not by this process`;
  const mode = stats.mode & 0o777;
  if (mode & 0o077) return `mode ${mode.toString(8).padStart(3, "0")} grants access beyond its owner`;
  return "";
}

/** Gather the folder's lstat, ACL and owner before applying the folder policy. */
export async function folderCustodyProblemFor(target, { platform = process.platform, env = process.env, lstat = fs.promises.lstat, run = execFileAsync } = {}) {
  let stats;
  try {
    stats = await lstat(target);
  } catch (failure) {
    return `could not inspect it: ${failure?.code || failure}`;
  }
  return folderCustodyProblem({
    platform,
    stats,
    aclPath: target,
    aclText: platform === "win32" ? await readAcl(target, run, env) : "",
    owner: platform === "win32" ? currentWindowsOwner(env) : "",
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
  });
}
