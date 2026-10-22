// Run by the-suite-runs-in-a-sealed-home.test.js, under the runner or directly: records where this process's code would
// look, through the code's own readers, into SEALED_HOME_PROBE_OUT. It lives under fixtures/ so the suite never runs it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeSettingsFiles } from "../../lib/claude-default-model.mjs";
import { hermesRoots } from "../../lib/hermes-config-install.mjs";

test("probe", () => {
  fs.writeFileSync(process.env.SEALED_HOME_PROBE_OUT, JSON.stringify({
    claudeUserSettings: claudeSettingsFiles(process.cwd()).at(-1),
    // aify-wrapper-connect's own read, bin/aify-wrapper-connect.mjs: `process.env.AIFY_SERVICE_REGISTRY`.
    registry: process.env.AIFY_SERVICE_REGISTRY ?? null,
    hermesRoots: hermesRoots({ env: process.env, platform: process.platform, homedir: os.homedir(), join: path.join, dirname: path.dirname, basename: path.basename }),
  }));
});
