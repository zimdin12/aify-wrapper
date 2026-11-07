#!/usr/bin/env node
// The installer's reader for `~/.aify/services.json`.
//
// Thin wiring over lib/registry.mjs: it supplies the one ambient thing (the file) and prints an
// answer. All the deciding lives in the pure module beside it, where it is tested.
//
// Public verbs (keep external consumers, not just install.sh, compatible):
//   install-pairs <path> <service> <transport> -> NAME=value lines; wrapper install.sh
//   fingerprint <path> -> digest; comms scripts/registry-fingerprint.sh and wrapper tests
//   strict-fragment-b64 <path> -> strict servers; comms scripts/registry-fragment.sh
//   session-fragment-b64 <path> -> session config; comms scripts/registry-fragment.sh
//   session-codex-b64 <path> -> NUL-terminated Codex words; wrapper install.sh and comms registry-fragment.sh
//   session-http-b64 <path> [own service] -> HTTP entries; comms scripts/registry-fragment.sh
//   mcp-transport <path> <service> -> declared transport; retained public query, no production caller established here
//
// EXIT CODES ARE THE POINT. A registry that does not parse exits 78 with its reasons on stderr, so the
// installer fails rather than building a launcher against whatever survived parsing. An ABSENT file is
// not that case: it exits 0 with the empty-registry answer, because a host with no service installed
// is a legitimate state and must stay distinguishable from a corrupt one.

import { readFileSync } from "node:fs";

import { parseRegistry, fingerprint, mcpTransportFor, sessionMcpConfigBase64, strictMcpFragmentBase64, strictMcpSecretProblem } from "./registry.mjs";
import { registryPairs } from "./launcher-rerender.mjs";
import { sessionCodexWordsBase64 } from "./session-codex.mjs";
import { sessionHttpBase64 } from "./session-http.mjs";
import { readRegistryPairCategories } from "./registry-pair-categories.mjs";

const EXIT_CONFIG = 78;

const [, , command, file, service] = process.argv;

if (!command || !file) {
  process.stderr.write("usage: registry-cli.mjs <fingerprint|strict-fragment-b64|session-fragment-b64|session-codex-b64> <path> | mcp-transport <path> <service> | session-http-b64 <path> [own service]\n");
  process.exit(EXIT_CONFIG);
}

let text = "";
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") {
    process.stderr.write(`registry: cannot read ${file}: ${error.message}\n`);
    process.exit(EXIT_CONFIG);
  }
  // ENOENT is the empty registry, not a failure.
}

const parsed = parseRegistry(text);
if (!parsed.ok) {
  process.stderr.write(`registry ${file} is not usable:\n`);
  for (const problem of parsed.errors) process.stderr.write(`  - ${problem}\n`);
  process.exit(EXIT_CONFIG);
}

if (command === "install-pairs") {
  // Every value the registry decides for an install, one `NAME=value` per line, from the rule connect's re-render
  // applies (registryPairs): one node start where install.sh made five. `service` is the launcher's own; the next
  // argument is the transport the installer was given, which a transport the service declares overrides.
  const decided = registryPairs(text, "", process.env, service ?? "", process.argv[5] ?? "");
  if (decided.problem) {
    process.stderr.write(`registry ${file}: ${decided.problem}\n`);
    process.exit(EXIT_CONFIG);
  }
  const clientSpecific = new Set(readRegistryPairCategories().clientSpecific);
  process.stdout.write(`${decided.pairs.filter((pair) => !clientSpecific.has(pair.slice(0, pair.indexOf("=")))).join("\n")}\n`);
} else if (command === "fingerprint") {
  process.stdout.write(`${fingerprint(parsed.registry)}\n`);
} else if (command === "mcp-transport") {
  // What `service` declares, or nothing: the installer then keeps its flag or the stdio default.
  process.stdout.write(mcpTransportFor(parsed.registry, service));
} else if (command === "strict-fragment-b64") {
  // REFUSED BEFORE IT IS WRITTEN, never repaired afterwards. The fragment is baked into a mode-755
  // launcher, so a credential that reaches it has already been published to every local user by the
  // time anything could notice. Failing here stops the install with the service and the variable
  // named, at the one moment somebody can still choose differently. See strictMcpSecretProblem.
  const secret = strictMcpSecretProblem(parsed.registry, process.env);
  if (secret) {
    process.stderr.write(`registry ${file}: ${secret}
`);
    process.exit(EXIT_CONFIG);
  }
  // No trailing newline: the installer bakes this verbatim into the launcher.
  process.stdout.write(strictMcpFragmentBase64(parsed.registry));
} else if (command === "session-fragment-b64") {
  // The default mode's per-session config: empty when no service opted in, and no trailing newline, so
  // the installer bakes it verbatim. No secret check is needed: parseRegistry refuses keyEnv beside it.
  process.stdout.write(sessionMcpConfigBase64(parsed.registry));
} else if (command === "session-http-b64") {
  // The services a launch reaches over HTTP (session-http.mjs), baked: the own service only when the installer names
  // it, which it does exactly when the launcher's transport is http. Names, endpoints and credential references, never
  // a key; empty when there are none, so a host with none reads no credential at launch.
  process.stdout.write(sessionHttpBase64(parsed.registry, { own: service ?? "" }));
} else if (command === "session-codex-b64") {
  // Codex's per-session servers: NUL-terminated `-c` words for the app-server, base64. Refused, never
  // repaired, when a name is not plain, so an install cannot quietly launch agents without the server.
  const codex = sessionCodexWordsBase64(parsed.registry);
  if (!codex.ok) {
    process.stderr.write(`registry ${file} cannot be given to codex:\n`);
    for (const problem of codex.problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(EXIT_CONFIG);
  }
  process.stdout.write(codex.value);
} else {
  process.stderr.write(`registry: unknown command '${command}'\n`);
  process.exit(EXIT_CONFIG);
}
