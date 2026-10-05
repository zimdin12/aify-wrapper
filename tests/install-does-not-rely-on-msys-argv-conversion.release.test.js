#!/usr/bin/env node
// The installer must hand Windows Node paths Node can actually read.
//
// `HERE` comes from `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd`, which under Git-Bash is an MSYS path
// like `/c/Users/.../aify-wrapper`. Windows Node reads that as `C:\c\Users\...` and cannot find the
// module. It works in an ordinary Git-Bash shell ONLY because MSYS rewrites path-shaped arguments on
// the way to a native binary -- an implicit behaviour of the shell, not a property of the code.
//
// Found in review, and my own suite could not see it: every test here runs through a shell that does
// the conversion, so the environment was rescuing the installer and the tests recorded the rescue as
// correctness. This runs with the conversion DISABLED, which is what any caller that sets
// MSYS2_ARG_CONV_EXCL, uses MSYS_NO_PATHCONV, or invokes bash from a non-MSYS parent already gets.
//
// The symptom is not subtle when it lands: install.sh exits 78 before writing a launcher.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const NOWHERE = "http://127.0.0.2:1";

const isWindows = process.platform === "win32";

test("render-only succeeds with MSYS argv conversion disabled", { skip: !isWindows && "Windows-only path semantics" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-noconv-"));
  try {
    execFileSync("bash", [INSTALL, "--client", "claude", "--endpoint", NOWHERE, "--render-only", dir], {
      encoding: "utf8",
      env: {
        ...process.env,
        // Exactly the condition the review reproduced: the shell stops rewriting POSIX paths into
        // native ones on their way to Windows Node.
        MSYS2_ARG_CONV_EXCL: "*",
        MSYS_NO_PATHCONV: "1",
      },
    });
    assert.ok(
      fs.existsSync(path.join(dir, "claude-aify")),
      "install.sh exited 0 but wrote no launcher",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
