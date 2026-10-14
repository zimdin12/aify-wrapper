// A service registry of the test's own, so install.sh never reads the live ~/.aify/services.json.
//
// install.sh builds every launcher against a registry, and with no `--registry` it reads the one in the HOME
// it runs under: the operator's, which other agents rewrite while a suite runs. A read that lands mid-write
// fails, and a test then exits 78 for a reason that is not in the test (2026-10-14, reinstall-recovers-the-
// endpoint, once in a full run). Every install a test runs passes `--registry` with this or a fixture of its own.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fresh, valid, empty version-1 registry; its path in the forward-slash form bash and node both read. */
export function emptyRegistry() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-registry-")), "services.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, services: {} }));
  return file.split(String.fromCharCode(92)).join("/");
}
