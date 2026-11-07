#!/usr/bin/env node
// The installer's eyes: which harnesses are on this machine.
//
// A thin wiring layer over lib/detect-harnesses.mjs — it supplies the two ambient things (the
// wrappers directory and the real PATH) and prints the answer. All the deciding lives in the pure
// module beside it, where it is tested, so the installer and the suite reach the same verdict.
//
// TSV: client<TAB>found|missing|invalid<TAB>path<TAB>command (or <invalid>).
// The first three fields stay in place; the final command field also survives an empty path.
// Exit is always 0. "No harness found" is an answer, not a failure — a host with none is a legitimate
// state and the caller decides what to do about it.

import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { harnessClientsFrom, detectHarnesses, whichFrom } from "./detect-harnesses.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrappersDir = process.argv[2] || join(ROOT, "wrappers");

let filenames = [];
try {
  filenames = readdirSync(wrappersDir);
} catch (error) {
  // No templates is not the same as no harnesses, and saying so on stderr keeps stdout parseable.
  process.stderr.write(`detect: cannot read ${wrappersDir}: ${error.message}\n`);
}

const which = whichFrom({
  pathValue: process.env.PATH ?? "",
  sep: process.platform === "win32" ? ";" : ":",
  // On Windows a bare name is rarely the executable; PATHEXT is what makes `claude` find claude.cmd.
  pathExt: process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""],
  isExecutable: (candidate) => {
    // Absence is the ORDINARY answer here, so it must not travel as an exception. whichFrom's own
    // catch is for the genuinely exceptional case (an unreadable directory), and conflating the two
    // would hide a real permissions problem inside the common path.
    try {
      accessSync(candidate, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
});

const clients = harnessClientsFrom(filenames);
const templates = Object.fromEntries(clients.map(client => {
  try { return [client, readFileSync(join(wrappersDir, `${client}-aify.sh.in`), "utf8")]; }
  catch { return [client, null]; } // An unreadable template is invalid, never a client-name fallback.
}));
for (const row of detectHarnesses({ clients, templates, lookup: which })) {
  const state = row.invalid ? "invalid" : row.found ? "found" : "missing";
  process.stdout.write(`${row.client}\t${state}\t${row.path ?? ""}\t${row.command ?? "<invalid>"}\n`);
}
