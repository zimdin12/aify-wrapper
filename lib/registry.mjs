// The service registry: `~/.aify/services.json`, parsed.
//
// Each service's installer writes its own entry; this package reads the file at INSTALL time and
// bakes what it finds into the launchers. Reading it at LAUNCH was rejected deliberately — hermes
// gives MCP discovery a 0.75s window and this project has already lost that fight once, which is why
// the bridge runtime is copied to a native dotfolder in the first place.
//
// Everything here is pure: text in, value out, no filesystem and no environment. The caller owns I/O.
// That is not tidiness — logic that can only be reached through a shell script can only fail in
// production, and the one predicate module extracted from this project's bridge for the same reason
// caught a real bug in its first test.
//
// GUARDS FAIL CLOSED. A registry that does not validate returns no registry at all, never a
// half-populated one. Half is how a host ends up with launchers built against one service because the
// second failed validation quietly, which is indistinguishable from a host where the second was never
// installed.

import { createHash } from "node:crypto";

/** The only schema version this package understands. An unknown version is refused, not guessed. */
export const REGISTRY_VERSION = 1;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

const EMPTY = () => ({ version: REGISTRY_VERSION, services: {} });

/**
 * Parse registry text.
 *
 * Absent text — missing file, empty file, whitespace — is a VALID EMPTY registry rather than an
 * error. A host with no service installed is a legitimate state and the launchers still install on
 * it; treating absence as failure would make "no services yet" indistinguishable from "the file is
 * corrupt", which are opposite situations with opposite remedies.
 *
 * @param {string|null|undefined} text
 * @returns {{ok: boolean, registry?: object, errors: string[]}}
 */
export function parseRegistry(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (raw === "") return { ok: true, registry: EMPTY(), errors: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`registry is not valid JSON: ${error.message}`] };
  }

  const errors = [];
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["registry must be a JSON object"] };
  }
  if (parsed.version !== REGISTRY_VERSION) {
    return {
      ok: false,
      errors: [`registry version ${JSON.stringify(parsed.version)} is not supported (expected ${REGISTRY_VERSION})`],
    };
  }
  if (!isPlainObject(parsed.services)) {
    return { ok: false, errors: ["registry.services must be an object keyed by service name"] };
  }

  const services = {};
  const claimedMcpNames = new Map();

  for (const name of Object.keys(parsed.services).sort()) {
    const entry = parsed.services[name];
    const where = `services.${name}`;

    if (!isPlainObject(entry)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (!isNonEmptyString(entry.endpoint)) {
      errors.push(`${where}.endpoint must be a non-empty string`);
      continue;
    }

    const endpointEnv = normaliseEndpointEnv(entry.endpointEnv, where, errors);
    const mcp = normaliseMcp(entry.mcp, where, errors, claimedMcpNames, name);

    services[name] = { endpoint: entry.endpoint.trim(), endpointEnv, mcp };
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, registry: { version: REGISTRY_VERSION, services }, errors: [] };
}

function normaliseEndpointEnv(value, where, errors) {
  // Optional, and its absence is meaningful rather than a default to fill in. See mcpEntriesFor.
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    errors.push(`${where}.endpointEnv must be an array of environment variable names`);
    return [];
  }
  return value.map((n) => n.trim());
}

function normaliseMcp(value, where, errors, claimedMcpNames, serviceName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${where}.mcp must be an array`);
    return [];
  }

  const out = [];
  value.forEach((server, index) => {
    const at = `${where}.mcp[${index}]`;
    if (!isPlainObject(server)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(server.name)) {
      errors.push(`${at}.name must be a non-empty string`);
      return;
    }
    if (!isNonEmptyString(server.command)) {
      errors.push(`${at}.command must be a non-empty string`);
      return;
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((a) => typeof a === "string"))) {
      errors.push(`${at}.args must be an array of strings`);
      return;
    }

    // mcpServers is a MAP. A duplicate name does not error anywhere downstream — it silently drops
    // one service, and which one survives depends on emission order. Refuse it at the boundary.
    const claimedBy = claimedMcpNames.get(server.name);
    if (claimedBy && claimedBy !== serviceName) {
      errors.push(`mcp server name ${JSON.stringify(server.name)} is claimed by both ${claimedBy} and ${serviceName}`);
      return;
    }
    if (claimedBy === serviceName) {
      errors.push(`mcp server name ${JSON.stringify(server.name)} is declared twice by ${serviceName}`);
      return;
    }
    claimedMcpNames.set(server.name, serviceName);

    out.push({ name: server.name, command: server.command, args: [...(server.args ?? [])] });
  });
  return out;
}

/**
 * The endpoint a named service is reachable at, or null when it is not registered.
 * @returns {string|null}
 */
export function endpointFor(registry, serviceName) {
  return registry?.services?.[serviceName]?.endpoint ?? null;
}

/**
 * Every registered MCP server, flattened and deterministically ordered, with its environment resolved.
 *
 * The env is built ONLY from the names the service declared in `endpointEnv`. A service that declared
 * none gets an empty env, and that is the correct answer rather than a gap: a runtime's per-server MCP
 * env block is key-scoped — proven on Claude Code 2.1.236, where a per-server AIFY_SERVER_URL beat an
 * inherited value while an inherited AIFY_COMMS_URL passed through untouched. So guessing a name would
 * work silently for the one service whose name we happened to guess, and fail silently for every
 * other, putting the bug as far as possible from where it was introduced.
 *
 * Ordering is by service name then declaration order, so two installs from one registry render
 * byte-identically. Without that, every reinstall looks like a change to anything comparing wrappers.
 */
export function mcpEntriesFor(registry) {
  const services = registry?.services ?? {};
  return Object.keys(services)
    .sort()
    .flatMap((serviceName) => {
      const service = services[serviceName];
      const env = Object.fromEntries(service.endpointEnv.map((key) => [key, service.endpoint]));
      return service.mcp.map((server) => ({ ...server, args: [...server.args], env: { ...env } }));
    });
}

/**
 * A stable digest of what a launcher was built from.
 *
 * Baked into each launcher so `--check` can report itself stale when a service is registered after
 * the launcher was installed — the same read-never-run rule that already governs
 * HARNESS_WRAPPER_VERSION, and for the same reason: asking a pre-contract wrapper its version by
 * executing it would launch the runtime.
 */
export function fingerprint(registry) {
  return createHash("sha256").update(canonicalise(registry ?? EMPTY())).digest("hex").slice(0, 16);
}

/** JSON with every object key sorted, so key order is not mistaken for a change. */
function canonicalise(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
