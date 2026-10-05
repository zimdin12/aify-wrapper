// The stub-runtime harness renders each launcher once and substitutes the bridge directory per launch
// (launch-to-a-stub-runtime.mjs). That is only honest while install.sh bakes the bridge directory in verbatim and
// nothing else per world. This holds it: the cached render with a real bridge path is byte-identical to what
// install.sh writes for that path. One client is enough: install.sh hands BRIDGE_DIR to the one render.sh every
// template goes through, and hermes' template uses it most (11 lines, 2026-10-05).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installerRender, renderLauncher } from "./launch-to-a-stub-runtime.mjs";

test("the harness's cached render is the render install.sh writes for that bridge directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-cached-render-"));
  const services = path.join(dir, "services.json");
  fs.writeFileSync(services, "");
  // A bridge path with a space and a second segment, so a substitution that stopped at either would show.
  const bridge = "/c/Users/Some One/aify bridge/x";
  assert.equal(renderLauncher("hermes", services, bridge), installerRender("hermes", services, bridge));
  fs.rmSync(dir, { recursive: true, force: true });
});
