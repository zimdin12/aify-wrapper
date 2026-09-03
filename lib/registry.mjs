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
  //: Case-folded, because two references differing only in case are ONE file on Windows and on
  //: macOS's default volume. Keyed by the folded form so a pair is caught however each is spelled.
  const claimedCredentialRefs = new Map();

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
    // Same shape, same rule: absent is an empty list, and an empty list means this service declares no
    // key names rather than that it refuses keys.
    const keyEnv = normaliseEndpointEnv(entry.keyEnv, `${where}.keyEnv`, errors);
    const mcp = normaliseMcp(entry.mcp, where, errors, claimedMcpNames, name);

    // Opting a service into strict mode has a cost attached, so it is a boolean or it is refused.
    // "true" and 1 are truthy to some readers and not others, and a config value whose meaning depends
    // on who parses it is worse than no value at all.
    if (entry.strictMcp !== undefined && typeof entry.strictMcp !== "boolean") {
      errors.push(`${where}.strictMcp must be true or false`);
      continue;
    }

    const credentialRef = normaliseCredentialRef(entry.credentialRef, where, errors);
    if (credentialRef) {
      // CASE-FOLD CLOSURE ACROSS THE MERGED REGISTRY. Two references differing only in case are one
      // file on a case-insensitive volume, so accepting both would have two services silently
      // sharing a credential -- and the host it was tested on might be the one where they are two.
      // Checked here because only the whole file can see the pair.
      const folded = credentialRef.toLowerCase();
      const claimedBy = claimedCredentialRefs.get(folded);
      if (claimedBy) {
        errors.push(
          `credentialRef ${JSON.stringify(credentialRef)} is claimed by both ${claimedBy} and `
          + `${name}; two services cannot share one credential file`,
        );
        continue;
      }
      claimedCredentialRefs.set(folded, name);
    }

    services[name] = {
      endpoint: entry.endpoint.trim(),
      endpointEnv,
      keyEnv,
      mcp,
      strictMcp: entry.strictMcp === true,
      credentialRef,
    };
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, registry: { version: REGISTRY_VERSION, services }, errors: [] };
}

//: One path segment, and deliberately narrower than "a legal filename": no separators, no drive
//: letters, nothing to decode later. `.` and `..` match this character class and are refused by name
//: below -- a charset test alone accepts both, which is the classic way a containment check passes
//: while resolving to the parent directory.
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * A reference to a credential FILE, validated here but never resolved here.
 *
 * WHY THIS PACKAGE VALIDATES IT. Nothing here reads credentials; this parser validates the registry
 * that names them, and aify-comms calls it authoritative before writing its own entry. A field this
 * parser merely passed through would be a field nothing checked -- and it did pass through, silently
 * dropped, until 2026-08-31, which meant the grammar below was enforced nowhere on the write path.
 *
 * WHERE the key lives, never what it is: this file is readable by everything on the host. Absent is
 * an empty string, meaning this service stores no credential here -- a normal state, not a fault.
 */
function normaliseCredentialRef(value, where, errors) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    errors.push(`${where}.credentialRef must be a string`);
    return "";
  }
  const text = value.trim();
  const bad = text === ""
    || text.length > 64
    || !CREDENTIAL_REF_PATTERN.test(text)
    || text === "."
    || text === ".."
    || text.startsWith(".");
  if (bad) {
    errors.push(
      `${where}.credentialRef must be one name of letters, digits, dot, dash or underscore, `
      + `not starting with a dot -- got ${JSON.stringify(value)}`,
    );
    return "";
  }
  return text;
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
 * Every registered MCP server, flattened and deterministically ordered, with its environment resolved.
 *
 * The env is built ONLY from the names the service declared — `endpointEnv` bound to its endpoint, and
 * `keyEnv` bound to whatever the process environment carries under those names. A service that
 * declared none gets an empty env, and that is the correct answer rather than a gap: a runtime's
 * per-server MCP env block is key-scoped — proven on Claude Code 2.1.236, where a per-server
 * AIFY_SERVER_URL beat an inherited value while an inherited AIFY_COMMS_URL passed through untouched.
 * So guessing a name would work silently for the one service whose name we happened to guess, and fail
 * silently for every other, putting the bug as far as possible from where it was introduced.
 *
 * THE KEY'S VALUE COMES FROM THE ENVIRONMENT, never from the registry. A shared file naming every
 * service's endpoint is fine; one holding every service's credential is a different object with
 * different handling, and this reader is not the place to invent it.
 *
 * AND IT IS PINNED EVEN WHEN EMPTY. Omitting the name is precisely what lets it be inherited, which
 * with one service is harmless — the inherited key IS that service's key — and with two means service
 * B's bridge presenting service A's credential. An empty value reads to a bridge exactly as no key.
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
      const env = {
        ...Object.fromEntries(service.endpointEnv.map((key) => [key, service.endpoint])),
        ...Object.fromEntries(service.keyEnv.map((key) => [key, process.env[key] ?? ""])),
      };
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

/**
 * The MCP servers an operator opted into strict mode, resolved like any other.
 *
 * Strict mode (`AIFY_CLAUDE_STRICT_MCP=1`) exists BECAUSE extra MCP servers cause the Claude Code
 * init race that leaves `aify-comms-channel` stuck in "still connecting" and stops channel
 * notifications. So it carries what was explicitly named and nothing else: emitting every registered
 * service would reintroduce exactly the failure the flag is the workaround for.
 *
 * Absent `strictMcp` means today's behaviour, byte for byte.
 */
export function strictMcpEntriesFor(registry) {
  const services = registry?.services ?? {};
  return mcpEntriesFor(registry).filter((entry) =>
    Object.values(services).some((service) => service.strictMcp && service.mcp.some((s) => s.name === entry.name)));
}

/**
 * Those entries as a JSON fragment that splices into the strict config, after the last entry.
 *
 * Plain text, escaped for nothing. Getting it to the launcher intact is `strictMcpFragmentBase64`'s
 * job, and the reason that exists is worth stating here so nobody re-adds escaping to this function:
 *
 * The fragment used to be escaped for the unquoted heredoc that writes the config. That is one hop
 * short. The value also passes through the installer's `${text//@@KEY@@/$value}` substitution, and
 * bash consumes a level of escaping THERE too — a path baked with four backslashes arrived at the
 * launcher with two. Escaping for both hops means encoding bash's replacement rules into this file
 * and hoping they hold across versions. Base64 removes the hops instead of counting them.
 *
 * An empty strict set yields an EMPTY string, so a host that opted nothing in gets the config it gets
 * today with nothing added and nothing reordered.
 */
/**
 * The reason strict mode would bake a live credential into every rendered launcher, or "".
 *
 * WRAP-M1. `mcpEntriesFor` resolves `keyEnv` to the VALUE the installing shell carries, and
 * `strictMcpFragment` writes that value into an `env` block which the installer bakes into each
 * launcher. A launcher is mode 755 -- world-readable by design, since it is a command on PATH -- so
 * any local user could read the fleet's credential out of it. Base64 is a transport encoding, not a
 * secret: the reproduction decoded it in one line.
 *
 * REPRODUCED 2026-09-03 rather than reasoned about: rendering with `strictMcp: true` and a key
 * exported produced `"AIFY_API_KEY": "<the key>"` inside the fragment. It has been latent only
 * because no service sets `strictMcp` -- measured on the live registry, where the fragment is the
 * empty string.
 *
 * WHY THIS REFUSES RATHER THAN SOLVING IT. Keeping the pin AND keeping the secret out of the file
 * means resolving the value in the launcher at RUN time, and the fragment is base64 precisely so its
 * content is never re-parsed by the shell -- reintroducing a substitution hop is how the escaping
 * bugs this encoding was chosen to end would come back. A design that resolves per-server env at run
 * time is worth having when a service actually needs strict mode with a credential; inventing one
 * speculatively, inside a package other services are about to consume, is not. Until then the honest
 * state is that this combination does not ship.
 *
 * IT IS THE COMBINATION THAT IS REFUSED, never `strictMcp` alone: a strict service with no `keyEnv`,
 * or one whose key is simply not set in the installing shell, renders exactly as before.
 */
export function strictMcpSecretProblem(registry, env = process.env) {
  const services = registry?.services ?? {};
  const offenders = [];
  for (const serviceName of Object.keys(services).sort()) {
    const service = services[serviceName];
    if (!service?.strictMcp) continue;
    for (const key of service.keyEnv ?? []) {
      if (String(env?.[key] ?? "").length) offenders.push(`${serviceName} (${key})`);
    }
  }
  if (offenders.length === 0) return "";
  return `strict-mode MCP would write a live credential into every rendered launcher, and a launcher `
    + `is world-readable: ${offenders.join(", ")}. Unset the variable for the install, or drop `
    + `"strictMcp" from that service until per-server env is resolved at run time.`;
}

export function strictMcpFragment(registry) {
  const entries = strictMcpEntriesFor(registry);
  if (entries.length === 0) return "";

  const body = entries.map((entry) => {
    const args = entry.args.map((arg) => JSON.stringify(arg)).join(", ");
    const env = Object.entries(entry.env)
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(", ");
    return [
      `    ${JSON.stringify(entry.name)}: {`,
      `      "command": ${JSON.stringify(entry.command)},`,
      `      "args": [${args}],`,
      `      "env": { ${env} }`,
      "    }",
    ].join("\n");
  }).join(",\n");

  return `,\n${body}`;
}

/**
 * The fragment as base64 — the form that survives the trip to the launcher.
 *
 * Base64 is `[A-Za-z0-9+/=]`, so it passes through the installer's parameter substitution and lands in
 * the launcher as itself. The launcher decodes it into a shell VARIABLE and expands that variable
 * inside the heredoc, and a variable expansion is not re-parsed — no backslash, dollar or backtick in
 * a service's path can be eaten or executed on the way. Correct by construction rather than by
 * counting escape levels.
 *
 * Empty stays empty, so the default path is untouched.
 */
export function strictMcpFragmentBase64(registry) {
  const fragment = strictMcpFragment(registry);
  return fragment === "" ? "" : Buffer.from(fragment, "utf8").toString("base64");
}

/** JSON with every object key sorted, so key order is not mistaken for a change. */
function canonicalise(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
