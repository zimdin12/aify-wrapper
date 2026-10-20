// What connect writes: a service's registry entry, built from its spec over what is already published.
//
// THE RAW ENTRY, NEVER THE READER'S PROJECTION. parseRegistry rebuilds an entry from the fields it normalises and
// drops the rest (lib/registry.mjs:131-142), and aify-env reads fields it drops (`secretsCredentialRef`,
// `advertise`). So the published entry is the base, the spec's fields go over it, and every field the spec does not
// name survives byte for byte. The parser is a gate on the result, never its author.
//
// SESSION IDENTITY STAYS IN THE SESSION. Nothing here reads the environment: an entry is the spec, the install
// roots and the absolute node, so no AIFY_* value and no key can reach the file (format freeze, item 4).
//
// Pure: values in, values out.

import { tupleDigest } from "./service-spec.mjs";

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Each artifact's standing: pending (with why), approved (catalogue or operator, by exact tuple digest), or not.
 *
 * @param {object[]} artifacts  the validated spec's artifacts
 * @param {Set<string>} approved  tuple digests the catalogue or the operator approved
 */
export function artifactStanding(artifacts, approved) {
  return artifacts.map((artifact) => {
    if (artifact.source.pending !== undefined) return { id: artifact.id, pending: artifact.source.pending };
    const digest = tupleDigest(artifact);
    return { id: artifact.id, digest, approved: approved.has(digest) };
  });
}

/**
 * The mcp servers this spec yields: `{command: <absolute node>, args: [<root>/<entry file>]}`, one rule for both kinds.
 *
 * @param {object} spec  validated
 * @param {Map<string, {root: string, files: Record<string,string>}>} resolved  per approved, materialised artifact:
 *   where it lives and the file each entry maps to (a file-set entry is its own file; a package entry is its bin's)
 * @param {string} execPath  the node running connect, recorded in the approved plan
 * @returns {{servers: object[], pending: {name: string, reason: string}[]}}
 */
export function renderServers(spec, standing, resolved, execPath) {
  const byId = new Map(standing.map((s) => [s.id, s]));
  const servers = [];
  const pending = [];
  for (const server of spec.mcp) {
    const state = byId.get(server.artifact);
    if (state.pending !== undefined) {
      pending.push({ name: server.name, reason: state.pending });
      continue;
    }
    const at = resolved.get(server.artifact);
    servers.push({ name: server.name, command: execPath, args: [`${at.root}/${at.files[server.entry]}`] });
  }
  return { servers, pending };
}

/**
 * The entry to publish: the existing raw entry, the spec's `fixed` over it, the endpoint, the servers (replacing
 * same-named ones and keeping the rest), and each supplied reference. A pending server's existing same-named entry
 * is kept: connect writes no entry for it, and does not delete one it did not make.
 */
export function mergeEntry(existing, { endpoint, fixed, servers, refs }) {
  const entry = isPlainObject(existing) ? structuredClone(existing) : {};
  for (const [key, value] of Object.entries(fixed)) entry[key] = structuredClone(value);
  entry.endpoint = endpoint;
  const current = Array.isArray(entry.mcp) ? entry.mcp : [];
  const fresh = new Map(servers.map((server) => [server.name, server]));
  const kept = current.map((server) => fresh.get(server?.name) ?? server);
  const added = servers.filter((server) => !current.some((old) => old?.name === server.name));
  if (kept.length || added.length) entry.mcp = [...kept, ...added];
  for (const [field, ref] of Object.entries(refs)) entry[field] = ref;
  return entry;
}

/**
 * The whole registry text with `name` set to `entry`, every other service carried over. Refuses a registry it
 * cannot read, rather than replacing it, for the reason aify-comms' upsertService gives: an unreadable file may hold
 * another service's entry.
 */
export function registryWith(existingText, name, entry) {
  const raw = typeof existingText === "string" ? existingText.trim() : "";
  let current = { version: 1, services: {} };
  if (raw !== "") {
    try {
      current = JSON.parse(raw);
    } catch (error) {
      return { ok: false, errors: [`refusing to rewrite an unreadable registry: ${error.message}`] };
    }
    if (!isPlainObject(current) || current.version !== 1 || !isPlainObject(current.services)) {
      return { ok: false, errors: ["refusing to rewrite a registry that is not version 1 with a services object"] };
    }
  }
  const services = { ...current.services, [name]: entry };
  return { ok: true, errors: [], text: `${stableJson({ ...current, services })}\n` };
}

/** The references an entry publishes now that it will not after the change: kept, and reported for cleanup. */
export function retiredRefs(existing, refs) {
  if (!isPlainObject(existing)) return [];
  return Object.entries(refs)
    .filter(([field, ref]) => typeof existing[field] === "string" && existing[field] !== "" && existing[field] !== ref)
    .map(([field]) => ({ field, ref: existing[field] }));
}

/** Sorted keys, two-space indent: the byte form aify-comms' registry writer produces (service-registry.mjs). */
export function stableJson(value, indent = "") {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${indent}  ${stableJson(item, `${indent}  `)}`).join(",\n")}\n${indent}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((key) => `${indent}  ${JSON.stringify(key)}: ${stableJson(value[key], `${indent}  `)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value ?? null);
}
