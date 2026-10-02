#!/usr/bin/env node
// The installer's reader for `~/.aify/services.json`.
//
// Thin wiring over lib/registry.mjs: it supplies the one ambient thing (the file) and prints an
// answer. All the deciding lives in the pure module beside it, where it is tested.
//
//   registry-cli.mjs fingerprint <path>   -> the digest of what a launcher is being built from
//   registry-cli.mjs strict-fragment-b64 <path> -> the opted-in servers, base64 for the launcher
//   registry-cli.mjs session-fragment-b64 <path> -> the default mode's per-session config, base64
//   registry-cli.mjs session-codex-b64 <path>    -> codex's per-session `-c` words, NUL-terminated, base64
//
// EXIT CODES ARE THE POINT. A registry that does not parse exits 78 with its reasons on stderr, so the
// installer fails rather than building a launcher against whatever survived parsing. An ABSENT file is
// not that case: it exits 0 with the empty-registry answer, because a host with no service installed
// is a legitimate state and must stay distinguishable from a corrupt one.

import { readFileSync } from "node:fs";

import { parseRegistry, fingerprint, sessionMcpConfigBase64, strictMcpFragmentBase64, strictMcpSecretProblem } from "./registry.mjs";
import { sessionCodexWordsBase64 } from "./session-codex.mjs";

const EXIT_CONFIG = 78;

const [, , command, file] = process.argv;

if (!command || !file) {
  process.stderr.write("usage: registry-cli.mjs <fingerprint|strict-fragment-b64|session-fragment-b64|session-codex-b64> <path>\n");
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

if (command === "fingerprint") {
  process.stdout.write(`${fingerprint(parsed.registry)}\n`);
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
