#!/usr/bin/env node
// The installer's reader for `~/.aify/services.json`.
//
// Thin wiring over lib/registry.mjs: it supplies the one ambient thing (the file) and prints an
// answer. All the deciding lives in the pure module beside it, where it is tested.
//
//   registry-cli.mjs fingerprint <path>   -> the digest of what a launcher is being built from
//   registry-cli.mjs mcp-json    <path>   -> every registered MCP server, resolved, as JSON
//   registry-cli.mjs strict-fragment-b64 <path> -> the opted-in servers, base64 for the launcher
//
// EXIT CODES ARE THE POINT. A registry that does not parse exits 78 with its reasons on stderr, so the
// installer fails rather than building a launcher against whatever survived parsing. An ABSENT file is
// not that case: it exits 0 with the empty-registry answer, because a host with no service installed
// is a legitimate state and must stay distinguishable from a corrupt one.

import { readFileSync } from "node:fs";

import { parseRegistry, mcpEntriesFor, fingerprint, strictMcpFragmentBase64 } from "./registry.mjs";

const EXIT_CONFIG = 78;

const [, , command, file] = process.argv;

if (!command || !file) {
  process.stderr.write("usage: registry-cli.mjs <fingerprint|mcp-json> <path>\n");
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
  // No trailing newline: the installer bakes this verbatim into the launcher.
  process.stdout.write(strictMcpFragmentBase64(parsed.registry));
} else if (command === "mcp-json") {
  process.stdout.write(`${JSON.stringify(mcpEntriesFor(parsed.registry))}\n`);
} else {
  process.stderr.write(`registry: unknown command '${command}'\n`);
  process.exit(EXIT_CONFIG);
}
