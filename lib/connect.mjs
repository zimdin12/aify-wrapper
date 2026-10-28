// `aify-wrapper-connect <name> <url>`: register one service on this host from the spec it serves.
//
// The order is the contract (aify-comms docs/superpowers/plans/guided-install/S1-spec-and-connect.md):
//   prepare  -- fetch the spec with no key, judge it, read the registry, settle every artifact and secret, and
//               have aify-env judge the draft entry with no store I/O (`--candidate-only`). Nothing is written
//               before this passes; the one credential read is a published reference's key, kept for the probe.
//   stage    -- each NEW key goes into aify-env's store under a fresh reference. A reconnect with no new key
//               reuses the published reference and stages nothing.
//   probe    -- health, then every probe a supplied secret names: 401 without a key, 401 with a wrong one, 200
//               with the key. Any redirect aborts.
//   validate -- the candidate registry passes parseRegistry AND aify-env's store-aware check (`--service`).
//   publish  -- under the registry lock, only if the file still holds what prepare read.
//   settle   -- newly staged references are removed only when nothing was committed; old ones are never removed,
//               only reported; launchers are re-rendered only after a commit.
// Any failure before publish leaves the registry, every reference and every launcher as they were.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkHealth, checkProbe, fetchManifest, fetchServed, fetchSpec } from "./connect-http.mjs";
import { installPackage } from "./package-install.mjs";
import { artifactStanding, dropProblem, leftoverFixed, mergeEntry, registryWith, renderServers, retiredRefs } from "./connect-entry.mjs";
import { rerenderLaunchers } from "./launcher-rerender.mjs";
import { parseRegistry } from "./registry.mjs";
import { COMMITTED, NOT_COMMITTED, publish, snapshot } from "./registry-publish.mjs";
import { isPackageFromGit, parseManifest, validateSpec } from "./service-spec.mjs";

export class Refused extends Error {}

/**
 * `path.join(root, ...segments)`, refused unless it lands strictly inside `root`. The spec validator already refuses
 * an id that is not one path segment; this holds the destination itself, at the join, whatever reached it.
 */
export function inside(root, ...segments) {
  const joined = path.join(root, ...segments);
  const relative = path.relative(path.resolve(root), path.resolve(joined));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Refused(`${segments.join("/")} resolves outside ${root}`);
  }
  return joined;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A file-set at `root` against its manifest: every listed file hashes to its line, and every entry is listed. Files
 * on disk the manifest does not list (node_modules, untracked files) are reported, never failed: the copy may hold
 * more than the commit, and nothing listed is executed from outside the list.
 *
 * @param {Map<string,string>} listed  path -> sha256, from parseManifest
 * @returns {{problems: string[], unlisted: string[]}}
 */
/**
 * The report line for `unlisted`: npm's dependency files (any path under a `node_modules` directory) counted apart,
 * and the sample drawn only from the rest, which are the ones worth a look. PURE.
 */
export function unlistedSummary(id, unlisted) {
  const dependency = (rel) => rel.split("/").includes("node_modules");
  const other = unlisted.filter((rel) => !dependency(rel));
  return { id, count: unlisted.length, dependencies: unlisted.length - other.length, sample: other.slice(0, 5) };
}

export function checkFileSet(root, listed, entries) {
  const problems = entries.filter((entry) => !listed.has(entry)).map((entry) => `entry ${entry} is not in the manifest`);
  for (const [file, hash] of listed) {
    let got;
    try {
      got = sha256(fs.readFileSync(path.join(root, file)));
    } catch (error) {
      problems.push(`${file} is missing (${error.code ?? error.message})`);
      continue;
    }
    if (got !== hash) problems.push(`${file} hashes ${got}, not its manifest line`);
  }
  const unlisted = [];
  const walk = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(dir, item.name), rel);
      else if (!listed.has(rel)) unlisted.push(rel);
    }
  };
  walk(root, "");
  return { problems, unlisted };
}

/**
 * @param {object} o
 * @param {string} o.name  the selected service
 * @param {string} o.endpoint  where the operator says it lives
 * @param {Record<string,string>} o.secrets  field -> key value supplied for this connect
 * @param {Set<string>} o.approved  tuple digests approved by the catalogue or the operator
 * @param {object} o.tools  {credentialSet(service, ref, value), credentialRemove(ref), registryCheckCandidate(file),
 *   registryCheck(file, service) -> warnings}
 * @param {(args: string[]) => string} o.npm  npm, for a package from git; o.packageRoot is where its revisions live
 */
export async function connect(o) {
  const report = { service: o.name, result: NOT_COMMITTED, staged: [], unprobed: [], pending: [], cleanupPending: [], launchers: [] };

  // PREPARE. Nothing here reads or writes a credential.
  const spec = await fetchSpec(o.endpoint);
  const judged = validateSpec(spec, { name: o.name, endpoint: o.endpoint });
  if (!judged.ok) throw new Refused(`the spec is refused:\n  - ${judged.errors.join("\n  - ")}`);
  const drop = o.drop ?? [];
  const unusable = dropProblem(drop, spec.fixed);
  if (unusable) throw new Refused(unusable);
  const before = snapshot(o.registryPath);
  const existing = publishedEntry(before.bytes, o.name);
  report.leftover = leftoverFixed(existing, spec.fixed).filter((key) => !drop.includes(key));
  report.dropped = drop.filter((key) => Object.hasOwn(existing ?? {}, key));
  const standing = artifactStanding(spec.artifacts, o.approved);
  const unapproved = standing.filter((s) => s.approved === false);
  if (unapproved.length) {
    throw new Refused(`artifact(s) not approved: ${unapproved.map((s) => `${s.id} (approve exactly this with --approve ${s.digest})`).join(", ")}`);
  }
  const destination = destinations(spec, o);
  const resolved = await resolveArtifacts(spec, standing, o, report);
  const keys = settleSecrets(spec, existing, o, report);
  // The entry as it will be, with the references this connect will stage, judged by aify-env with no store I/O: a
  // collision or a bad reference is refused before any key is written. A package's server is not known until it is
  // installed, after the probes, so this draft keeps whatever entry of that name is already published.
  const planned = Object.fromEntries(Object.keys(o.secrets).map((field) => [field, heldRef(existing, field, o) ?? stagedRef(o.name, field)]));
  const unresolved = standing.map((s) => (s.pending === undefined && !resolved.has(s.id) ? { ...s, pending: "installed after the probes" } : s));
  const draft = candidateText(before, existing, o, spec, renderServers(spec, unresolved, resolved, o.execPath).servers, planned);
  withCandidateFile(draft, (file) => o.tools.registryCheckCandidate(file));

  // STAGE.
  const refs = {};
  try {
    for (const [field, value] of Object.entries(o.secrets)) {
      const ref = planned[field];
      // Already holding this exact key: nothing to stage, and never in `staged`, so a failed connect cannot remove it.
      if (ref === existing?.[field]) { refs[field] = ref; continue; }
      o.tools.credentialSet(o.name, ref, value);
      report.staged.push(ref);
      refs[field] = ref;
    }

    // PROBE.
    await checkHealth(o.endpoint, spec);
    for (const secret of spec.secrets) {
      if (!keys[secret.field]) continue;
      if (secret.probe === undefined) { report.unprobed.push(secret.field); continue; }
      await checkProbe(o.endpoint, spec.verify.probes[secret.probe], keys[secret.field]);
    }
    await fetchServedArtifacts(spec, o, keys, report, destination);
    installPackages(spec, standing, o, resolved, report, destination);

    // VALIDATE.
    const { servers, pending } = renderServers(spec, standing, resolved, o.execPath);
    report.pending.push(...pending);
    const candidate = { text: candidateText(before, existing, o, spec, servers, refs) };
    // Now the store holds the staged keys, the store-aware check: this service's references must exist.
    report.warnings = withCandidateFile(candidate.text, (file) => o.tools.registryCheck(file, o.name));

    // PUBLISH.
    const published = await publish(o.registryPath, candidate.text, before.hash, { waitMs: o.lockWaitMs });
    report.result = published.result;
    report.detail = published.detail;
    if (published.result === COMMITTED) report.cleanupPending = retiredRefs(existing, refs);
  } finally {
    // SETTLE: a staged reference may be live unless the registry provably does not name it.
    if (report.result === NOT_COMMITTED) {
      for (const ref of report.staged) {
        try {
          o.tools.credentialRemove(ref);
        } catch (error) {
          report.unremoved = [...(report.unremoved ?? []), `${ref}: ${error.message}`];
        }
      }
      report.staged = [];
    }
  }
  if (report.result !== COMMITTED) {
    const kept = report.staged.length ? ` Staged references kept, since the registry may name them: ${report.staged.join(", ")}.` : "";
    throw Object.assign(new Refused(`the publish is ${report.result}: ${report.detail}.${kept}`), { report });
  }
  try {
    report.launchers = rerenderLaunchers({ dest: o.dest, registryPath: o.registryPath, wrapperRoot: o.wrapperRoot, env: o.env });
  } catch (error) {
    report.launchers = [{ name: o.dest, state: "failed", detail: `${error.message}; aify-wrapper-check reports them stale` }];
  }
  return report;
}

function publishedEntry(bytes, name) {
  const text = bytes.toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text)?.services?.[name];
  } catch {
    return undefined; // registryWith refuses the unreadable file before anything is written
  }
}

/** Every secret's key for the probe: supplied, or read from the published reference. A required one with neither stops here. */
function settleSecrets(spec, existing, o, report) {
  const keys = {};
  const known = new Set(spec.secrets.map((s) => s.field));
  for (const field of Object.keys(o.secrets)) {
    if (!known.has(field)) throw new Refused(`${field} is not a secret ${o.name} declares`);
  }
  for (const secret of spec.secrets) {
    if (o.secrets[secret.field] !== undefined) { keys[secret.field] = o.secrets[secret.field]; continue; }
    const ref = existing?.[secret.field];
    const stored = typeof ref === "string" && ref ? o.readStored(ref) : "";
    if (stored) keys[secret.field] = stored;
    else if (secret.required) throw new Refused(`${secret.field} is required and none is stored or supplied; nothing was staged or written`);
    else report.absent = [...(report.absent ?? []), secret.field];
  }
  return keys;
}

/** Where each approved, non-pending artifact's entries live, checked file by file against the manifest it serves. */
async function resolveArtifacts(spec, standing, o, report) {
  const resolved = new Map();
  for (const state of standing) {
    if (state.pending !== undefined) continue;
    const artifact = spec.artifacts.find((a) => a.id === state.id);
    if (isPackageFromGit(artifact)) continue; // installed after the probes, by installPackages
    if (artifact.kind !== "file-set" || !artifact.source.git) {
      // Installing a package, or a tarball the service serves, is the chain's acquire phase (S2). Until then no
      // entry is written for it, and the report says so instead of pointing an entry at nothing.
      state.pending = "served: fetched and verified, installed by the acquire phase";
      continue;
    }
    const manifest = parseManifest(await fetchManifest(o.endpoint, artifact));
    if (!manifest.ok) throw new Refused(`${artifact.id}: the manifest is refused: ${manifest.errors.slice(0, 5).join("; ")}`);
    const root = o.fileSetRoot ?? `${o.home}/.${o.name}/mcp/stdio`;
    const { problems, unlisted } = checkFileSet(root, manifest.files, artifact.entries);
    if (problems.length) {
      throw new Refused(`${artifact.id} at ${root} does not match its manifest (${problems.length}): ${problems.slice(0, 5).join("; ")}`);
    }
    if (unlisted.length) report.unlisted = [...(report.unlisted ?? []), unlistedSummary(artifact.id, unlisted)];
    resolved.set(artifact.id, { root, files: Object.fromEntries(artifact.entries.map((e) => [e, e])) });
  }
  return resolved;
}

/**
 * Each approved package from git, installed at its spec's revision (lib/package-install.mjs). After the probes, so a
 * wrong key installs nothing; before validate, so an entry is only ever written for a checked install.
 */
function installPackages(spec, standing, o, resolved, report, destination) {
  for (const state of standing) {
    const artifact = spec.artifacts.find((a) => a.id === state.id);
    if (state.pending !== undefined || !isPackageFromGit(artifact)) continue;
    const at = installPackage({ artifact, root: destination.get(artifact.id), npm: o.npm, Fail: Refused });
    resolved.set(artifact.id, at);
    report.installed = [...(report.installed ?? []), { id: artifact.id, at: at.root, reused: at.reused }];
  }
}

/**
 * Where each package from git and each served artifact will be written, settled in prepare: an id that escapes its
 * root is refused before any key is staged, any request is made or npm runs.
 */
function destinations(spec, o) {
  const at = new Map();
  for (const artifact of spec.artifacts) {
    if (isPackageFromGit(artifact)) at.set(artifact.id, inside(o.packageRoot, o.name, artifact.id));
    else if (artifact.source.served) at.set(artifact.id, inside(o.stagingDir, `${artifact.id}.tgz`));
  }
  return at;
}

async function fetchServedArtifacts(spec, o, keys, report, destination) {
  for (const artifact of spec.artifacts.filter((a) => a.source.served)) {
    const probe = spec.secrets.find((s) => s.field === "credentialRef")?.probe;
    if (!probe || !keys.credentialRef) throw new Refused(`${artifact.id} is served, and fetching it needs the probed service key`);
    const bytes = await fetchServed(o.endpoint, artifact, spec.verify.probes[probe].header, keys.credentialRef);
    const file = destination.get(artifact.id);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    report.fetched = [...(report.fetched ?? []), file];
  }
}

/** The registry text with this service's entry merged over the published one; parseRegistry is its gate, never its author. */
function candidateText(before, existing, o, spec, servers, refs) {
  const entry = mergeEntry(existing, { endpoint: o.endpoint, fixed: spec.fixed, servers, refs, drop: o.drop ?? [] });
  const candidate = registryWith(before.bytes.toString("utf8"), o.name, entry);
  if (!candidate.ok) throw new Refused(candidate.errors.join("; "));
  const parsed = parseRegistry(candidate.text);
  if (!parsed.ok) throw new Refused(`the candidate registry would not parse:\n  - ${parsed.errors.join("\n  - ")}`);
  return candidate.text;
}

function withCandidateFile(text, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-connect-"));
  try {
    const file = path.join(dir, "services.json");
    fs.writeFileSync(file, text);
    return check(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The published reference for `field` when the store already holds exactly `o.secrets[field]` there, else null. A
 * rerun with the same key (the guided install's rerun after its sudo line) then rotates nothing and orphans nothing.
 */
function heldRef(existing, field, o) {
  const ref = existing?.[field];
  if (typeof ref !== "string" || !ref) return null;
  try {
    return o.readStored(ref) === o.secrets[field] ? ref : null;
  } catch {
    return null;
  }
}

/** A fresh reference within aify-env's grammar: at most 64 of [A-Za-z0-9._-], never starting with a dot. */
export function stagedRef(name, field) {
  return `${name.slice(0, 28)}-${field.slice(0, 22)}-${randomBytes(5).toString("hex")}`.replace(/^[.]/, "x");
}

/**
 * The aify-env tools connect calls, as `node <aify-env.mjs> credential ...` and `... registry check`: the store's
 * own commands, so connect never writes a credential file itself.
 *
 * A NON-ZERO EXIT REFUSES BEFORE ANY OUTPUT IS READ. Usage and I/O failures (64, 65) print to stderr with no JSON;
 * only an evaluated candidate answers JSON (0 ok, 65 with its problems listed). The JSON is read afterwards, to name
 * the problems; without it the refusal names stderr. An exit 0 must carry a passing verdict, or it refuses too.
 */
export function aifyEnvTools(aifyEnvBin, env = process.env) {
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [aifyEnvBin, ...args], { input, encoding: "utf8", env, timeout: 60_000 });
    if (result.status !== 0) {
      const why = problemsIn(result.stdout) || `exit ${result.status}: ${(result.stderr || result.error?.message || "no output").trim()}`;
      throw new Refused(`aify-env ${args.slice(0, 2).join(" ")} failed: ${why}`);
    }
    return result.stdout;
  };
  const check = (args) => {
    const verdict = parsed(run(args));
    if (verdict?.ok !== true || !Array.isArray(verdict.problems) || verdict.problems.length) {
      throw new Refused(`aify-env registry check exited 0 without a passing verdict: ${JSON.stringify(verdict)?.slice(0, 200)}`);
    }
    return (verdict.warnings ?? []).map((w) => `${w.service}.${w.field}: ${w.detail}`);
  };
  return {
    credentialSet: (service, ref, value) => run(["credential", "set", "--service", service, "--stdin", `--ref=${ref}`], `${value}\n`),
    credentialRemove: (ref) => run(["credential", "remove", `--ref=${ref}`]),
    // `--candidate-only`: grammar, version, collisions, advertising, and no store I/O, for the prepare phase.
    registryCheckCandidate: (file) => check(["registry", "check", "--candidate-only", file]),
    // `--service`: the store must hold THIS service's references; another service's missing key is a warning, so a
    // connect is never blocked by a neighbour (operator decision, guided install S1).
    registryCheck: (file, service) => check(["registry", "check", "--service", service, file]),
  };
}

function parsed(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** `aify-env registry check` answers JSON on stdout, `{check, ok, references, problems, warnings}`; its problems read. */
function problemsIn(stdout) {
  const problems = parsed(stdout)?.problems;
  return Array.isArray(problems) ? problems.map((p) => `${p.code}: ${p.service}.${p.field}: ${p.detail}`).join("; ") : "";
}
