// A service's self-description, `GET <endpoint>/.well-known/aify-service`, judged before anything is trusted.
//
// THE SPEC IS METADATA, NEVER AUTHORITY. It is fetched with no key, so anyone who can answer that URL can write it.
// It may describe routes and artifacts; it cannot make this host read a credential for another origin, run a
// program nobody approved, or set a credential reference. Each rule below is one of those doors, shut here so
// connect never has to remember them (aify-comms docs/superpowers/plans/guided-install/S1-spec-and-connect.md,
// "The concrete document" and "Format freeze").
//
// Pure: values in, values out. The caller owns the network and the filesystem.

import { createHash } from "node:crypto";

import { READ_FIELDS } from "./registry.mjs";

export const SPEC_VERSION = 1;
export const SPEC_PATH = "/.well-known/aify-service";

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "" && v === v.trim();

//: aify-env's own grammar for a field that names a credential file (lib/credential-store.mjs isCredentialRefField).
export const isCredentialRefField = (key) => /^(?:c|[a-z][A-Za-z0-9]*C)redentialRef$/.test(String(key));
//: Broader, for what `fixed` may NOT hold: any spelling ending in CredentialRef, at any depth, is a reference the
//: spec is trying to set, and references belong to `secrets`.
const namesACredential = (key) => /credentialref$/i.test(String(key));
//: The two registry fields connect derives itself.
const DERIVED_FIELDS = ["endpoint", "mcp"];
//: What aify-env reads from an entry beyond its credential references (aify-env lib/services.mjs readServices);
//: tests/fixed-fields-have-owners.test.js holds this to that reader's source.
export const ENV_READ_FIELDS = Object.freeze(["advertise", "advertisement"]);
//: A `fixed` field is copied into the published entry, so it is admitted only when a reader validates it. A field
//: nobody reads would be published unvalidated, from metadata anyone answering the URL can write.
const OWNED_FIXED = new Set([...READ_FIELDS, ...ENV_READ_FIELDS].filter((key) => !DERIVED_FIELDS.includes(key)));

//: One path segment on every platform: no separator, no drive or stream colon, no leading or trailing dot (`.`,
//: `..`, and Windows' `name.` alias of `name`), and no Windows device name, which opens the device whatever the
//: directory. An id and a service name are joined into install paths, so a value this refuses never reaches one.
const SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Why `value` cannot be one filesystem path segment, or "". */
function segmentProblem(value) {
  if (typeof value !== "string" || !SEGMENT.test(value)) {
    return `${JSON.stringify(value)} is not one path segment of at most 64 [A-Za-z0-9._-], starting and ending with no dot`;
  }
  if (WINDOWS_DEVICE.test(value)) return `${JSON.stringify(value)} is a Windows device name`;
  return "";
}

const TOP_KEYS = ["specVersion", "name", "version", "fixed", "artifacts", "mcp", "secrets", "verify"];
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const GIT_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BIN_NAME = /^[A-Za-z0-9._-]+$/;
const HEADER = /^[A-Za-z0-9-]+$/;

/** Why `path` is not a route on the service's own origin, or "". The registry's rule (lib/registry.mjs:188-189). */
export function routeProblem(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\\u0000- \u007f]/.test(path)) {
    return `${JSON.stringify(path)} is not an absolute path with no scheme or host`;
  }
  return "";
}

/**
 * `path` resolved ORIGIN-RELATIVE against `endpoint`: `http://h/comms` + `/api/v1/agents` is `http://h/api/v1/agents`,
 * never a concatenation. Throws when the result leaves the endpoint's origin, which routeProblem already excludes;
 * the check is repeated because a URL parser, not a string rule, is the last word on where a request goes.
 */
export function resolveRoute(endpoint, path) {
  const base = new URL(endpoint);
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) throw new Error(`${path} resolves to ${url.origin}, not ${base.origin}`);
  return url.href;
}

/**
 * The exact tuple an approval binds, canonically serialised and hashed: kind, source, sha256 and entries. A package
 * from git binds {kind, repo, entries}: approving the repository approves the revision its spec names (operator
 * decision, guided install S1), and installPackage holds npm to that revision.
 */
export function tupleDigest(artifact) {
  const { kind, source, sha256, entries } = artifact;
  const tuple = isPackageFromGit(artifact) ? { kind, repo: source.git.repo, entries } : { kind, source, sha256: sha256 ?? null, entries };
  return createHash("sha256").update(canonical(tuple)).digest("hex");
}

export const isPackageFromGit = (artifact) => artifact?.kind === "package" && isPlainObject(artifact.source?.git);

/**
 * Judge a fetched spec for the service the operator selected.
 *
 * @param {unknown} spec  the parsed body
 * @param {{name: string, endpoint: string}} target
 * @returns {{ok: boolean, errors: string[], spec?: object}}
 */
export function validateSpec(spec, { name, endpoint }) {
  const errors = [];
  if (!isPlainObject(spec)) return { ok: false, errors: ["the spec is not a JSON object"] };
  const unknown = Object.keys(spec).filter((key) => !TOP_KEYS.includes(key));
  if (unknown.length) errors.push(`the spec carries unknown field(s) ${unknown.join(", ")}`);
  if (spec.specVersion !== SPEC_VERSION) {
    return { ok: false, errors: [`specVersion ${JSON.stringify(spec.specVersion)} is not supported (expected ${SPEC_VERSION})`] };
  }
  if (spec.name !== name) errors.push(`the spec names ${JSON.stringify(spec.name)}, not the selected service ${JSON.stringify(name)}`);
  const badName = segmentProblem(name);
  if (badName) errors.push(`the service name ${badName}`);
  if (spec.version !== undefined && typeof spec.version !== "string") errors.push("version must be a string");

  const routes = [];
  checkFixed(spec.fixed, errors, routes);
  const artifacts = checkArtifacts(spec.artifacts, errors, routes);
  checkMcp(spec.mcp, artifacts, errors);
  const probes = checkVerify(spec.verify, errors, routes);
  checkSecrets(spec.secrets, probes, errors);

  for (const { where, path } of routes) {
    const bad = routeProblem(path);
    if (bad) { errors.push(`${where}: ${bad}`); continue; }
    try {
      resolveRoute(endpoint, path);
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], spec };
}

function checkFixed(fixed, errors, routes) {
  if (!isPlainObject(fixed)) { errors.push("fixed must be an object"); return; }
  for (const key of DERIVED_FIELDS) {
    if (Object.hasOwn(fixed, key)) errors.push(`fixed.${key} is derived by connect; a spec may not set it`);
  }
  for (const where of credentialKeysIn(fixed, "fixed")) errors.push(`${where} names a credential; secrets owns references`);
  for (const key of Object.keys(fixed)) {
    if (DERIVED_FIELDS.includes(key) || namesACredential(key) || OWNED_FIXED.has(key)) continue;
    errors.push(`fixed.${key} has no reader that validates it; fixed may set ${[...OWNED_FIXED].join(", ")}`);
  }
  for (const field of ["agentState", "turnStart"]) {
    if (isPlainObject(fixed[field])) routes.push({ where: `fixed.${field}.path`, path: fixed[field].path });
  }
}

function credentialKeysIn(value, where) {
  if (Array.isArray(value)) return value.flatMap((item, i) => credentialKeysIn(item, `${where}[${i}]`));
  if (!isPlainObject(value)) return [];
  return Object.keys(value).flatMap((key) => [
    ...(namesACredential(key) ? [`${where}.${key}`] : []),
    ...credentialKeysIn(value[key], `${where}.${key}`),
  ]);
}

function checkArtifacts(list, errors, routes) {
  const byId = new Map();
  //: Case-folded: `Bridge` and `bridge` are one directory on Windows and macOS, so two ids may not differ only so.
  const folded = new Set();
  if (!Array.isArray(list)) { errors.push("artifacts must be an array"); return byId; }
  list.forEach((artifact, index) => {
    const at = `artifacts[${index}]`;
    if (!isPlainObject(artifact)) { errors.push(`${at} must be an object`); return; }
    const extra = Object.keys(artifact).filter((k) => !["id", "kind", "source", "sha256", "entries", "manifest"].includes(k));
    // `command` and anything else a spec might use to name a program are refused here, by being unknown.
    if (extra.length) errors.push(`${at} carries unknown field(s) ${extra.join(", ")}`);
    const badId = segmentProblem(artifact.id);
    if (badId) errors.push(`${at}.id ${badId}`);
    else if (folded.has(artifact.id.toLowerCase())) errors.push(`${at}.id ${JSON.stringify(artifact.id)} repeats another id, ignoring case`);
    else folded.add(artifact.id.toLowerCase());
    if (!["package", "file-set"].includes(artifact.kind)) errors.push(`${at}.kind must be package or file-set`);
    if (!Array.isArray(artifact.entries) || !artifact.entries.length || !artifact.entries.every(isText)) {
      errors.push(`${at}.entries must be a non-empty array of names`);
    } else {
      for (const entry of artifact.entries) {
        const bad = artifact.kind === "package" ? !BIN_NAME.test(entry) : relativeFileProblem(entry);
        if (bad) errors.push(`${at}.entries: ${JSON.stringify(entry)} is not a ${artifact.kind === "package" ? "bin name" : "relative file path"}`);
      }
    }
    const source = checkSource(artifact, at, errors, routes);
    checkManifest(artifact, source, at, errors, routes);
    if (source === "git" && artifact.kind === "package") {
      // ITS REVISION IS ITS PIN. npm builds it on this host, so no hash of bytes exists to compare; a sha256 here is a
      // claim nothing checks, refused like pending+hash.
      if (artifact.sha256 !== undefined) errors.push(`${at} is a package from git and may not carry a sha256; its revision pins it`);
    } else if (source !== "pending" && !SHA256.test(String(artifact.sha256 ?? ""))) errors.push(`${at}.sha256 must be 64 lowercase hex`);
    if (isText(artifact.id)) byId.set(artifact.id, artifact);
  });
  return byId;
}

/**
 * A file-set's manifest is served by the service at `manifest.path`: the list its sha256 binds. A package has none,
 * and a pending artifact names no URL of any kind.
 */
function checkManifest(artifact, source, at, errors, routes) {
  const wanted = artifact.kind === "file-set" && source !== "pending";
  if (artifact.manifest === undefined) {
    if (wanted) errors.push(`${at}.manifest {path} is required for a file-set`);
    return;
  }
  if (!wanted) { errors.push(`${at}.manifest belongs only to a file-set that is not pending`); return; }
  if (!isPlainObject(artifact.manifest) || Object.keys(artifact.manifest).some((k) => k !== "path")) {
    errors.push(`${at}.manifest must be {path}`);
    return;
  }
  routes.push({ where: `${at}.manifest.path`, path: artifact.manifest.path });
}

/**
 * A file-set manifest: `sha256sum` text, `<64 hex>  <relative/path>` per line, LF, sorted by path. Paths are relative,
 * with no `..`, no leading slash and no backslash.
 *
 * @returns {{ok: boolean, errors: string[], files?: Map<string,string>}}  path -> sha256
 */
export function parseManifest(text) {
  const errors = [];
  const files = new Map();
  const LF = String.fromCharCode(10);
  if (!text.endsWith(LF)) return { ok: false, errors: ["the manifest does not end with a line feed"] };
  let previous = "";
  for (const [index, line] of text.slice(0, -1).split(LF).entries()) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    const where = `manifest line ${index + 1}`;
    if (!match) { errors.push(`${where} is not "<sha256>  <path>"`); continue; }
    const [, hash, file] = match;
    if (relativeFileProblem(file)) { errors.push(`${where}: ${JSON.stringify(file)} is not a relative path inside the root`); continue; }
    if (files.has(file) || file <= previous) errors.push(`${where}: ${JSON.stringify(file)} is out of order or repeated`);
    previous = file;
    files.set(file, hash);
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], files };
}

function checkSource(artifact, at, errors, routes) {
  const source = artifact.source;
  const kinds = isPlainObject(source) ? Object.keys(source) : [];
  if (kinds.length !== 1 || !["git", "served", "pending"].includes(kinds[0])) {
    errors.push(`${at}.source must be exactly one of git, served or pending`);
    return "";
  }
  const [kind] = kinds;
  const value = source[kind];
  if (kind === "pending") {
    if (!isText(value)) errors.push(`${at}.source.pending must say why`);
    // ONE REPRESENTATION FOR "NOT AVAILABLE": a pending artifact that also carries a hash is two claims at once.
    if (artifact.sha256 !== undefined) errors.push(`${at} is pending and may not carry a sha256`);
  } else if (kind === "git") {
    if (!isPlainObject(value) || Object.keys(value).some((k) => !["repo", "revision"].includes(k))
        || !GIT_REPO.test(String(value.repo ?? "")) || !GIT_REVISION.test(String(value.revision ?? ""))) {
      errors.push(`${at}.source.git must be {repo: "owner/name", revision: <full 40-hex commit, never a short sha, branch or tag>}`);
    }
  } else if (!isPlainObject(value) || Object.keys(value).some((k) => !["path", "version"].includes(k))
      || !isText(value.version)) {
    errors.push(`${at}.source.served must be {path, version}`);
  } else {
    routes.push({ where: `${at}.source.served.path`, path: value.path });
  }
  return kind;
}

function relativeFileProblem(entry) {
  return /^[\\/]|^[A-Za-z]:|\\|(^|\/)\.\.?(\/|$)|[\u0000-\u001f\u007f]/.test(entry);
}

function checkMcp(list, artifacts, errors) {
  if (!Array.isArray(list)) { errors.push("mcp must be an array"); return; }
  const names = new Set();
  list.forEach((server, index) => {
    const at = `mcp[${index}]`;
    if (!isPlainObject(server)) { errors.push(`${at} must be an object`); return; }
    const extra = Object.keys(server).filter((k) => !["name", "artifact", "entry"].includes(k));
    if (extra.length) errors.push(`${at} carries unknown field(s) ${extra.join(", ")}; a server names an artifact entry, never a command`);
    if (!isText(server.name) || names.has(server.name)) errors.push(`${at}.name must be a unique non-empty string`);
    names.add(server.name);
    const artifact = artifacts.get(server.artifact);
    if (!artifact) errors.push(`${at}.artifact ${JSON.stringify(server.artifact)} is not a declared artifact`);
    else if (!artifact.entries?.includes(server.entry)) errors.push(`${at}.entry ${JSON.stringify(server.entry)} is not an entry of ${server.artifact}`);
  });
}

function checkVerify(verify, errors, routes) {
  const probes = new Set();
  if (!isPlainObject(verify) || Object.keys(verify).some((k) => !["health", "probes"].includes(k))) {
    errors.push("verify must be {health, probes}");
    return probes;
  }
  if (!isPlainObject(verify.health) || Object.keys(verify.health).some((k) => k !== "path")) errors.push("verify.health must be {path}");
  else routes.push({ where: "verify.health.path", path: verify.health.path });
  if (!isPlainObject(verify.probes)) { errors.push("verify.probes must be an object"); return probes; }
  for (const [name, probe] of Object.entries(verify.probes)) {
    const at = `verify.probes.${name}`;
    if (!isPlainObject(probe) || Object.keys(probe).some((k) => !["path", "header"].includes(k)) || !HEADER.test(String(probe.header ?? ""))) {
      errors.push(`${at} must be {path, header}`);
      continue;
    }
    routes.push({ where: `${at}.path`, path: probe.path });
    probes.add(name);
  }
  return probes;
}

function checkSecrets(list, probes, errors) {
  if (!Array.isArray(list)) { errors.push("secrets must be an array"); return; }
  const fields = new Set();
  list.forEach((secret, index) => {
    const at = `secrets[${index}]`;
    if (!isPlainObject(secret) || Object.keys(secret).some((k) => !["field", "required", "probe"].includes(k))) {
      errors.push(`${at} must be {field, required, probe?}`);
      return;
    }
    if (!isCredentialRefField(secret.field) || fields.has(secret.field)) errors.push(`${at}.field must be a unique credential reference field`);
    fields.add(secret.field);
    if (typeof secret.required !== "boolean") errors.push(`${at}.required must be true or false`);
    // A DANGLING PROBE NAME REFUSES THE SPEC. Read as "no probe" it would turn a typo into an unverified key.
    if (secret.probe !== undefined && !probes.has(secret.probe)) errors.push(`${at}.probe ${JSON.stringify(secret.probe)} names no verify.probes entry`);
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
