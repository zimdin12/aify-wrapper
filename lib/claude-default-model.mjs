// The model Claude Code would pick for a NEW session here, from its settings files (aify-wrapper 0.9.1).
//
// A resumed Claude session restores the model its transcript saved unless the launch names one with `--model`
// or `ANTHROPIC_MODEL` (Claude Code docs, model configuration). So a default changed in Claude's settings never
// reached an agent that resumes: three managers kept `claude-opus-5` after `opus` moved on (aify-comms,
// measured 2026-10-04). claude-aify asks this for a resume that selects no model, and passes the answer.
//
// The settings Claude reads, most specific first: the project's local settings, the project's shared
// settings, then the user's (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Managed (enterprise) settings are not
// read: no host here has them, and a launch that passes nothing behaves as before.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** PURE. The first usable `model` among parsed settings objects, most specific first; "" when none names one. */
export function claudeDefaultModel(settings) {
  for (const entry of settings) {
    const model = entry !== null && typeof entry === "object" ? entry.model : undefined;
    if (typeof model === "string" && model.trim() && !CONTROL.test(model)) return model.trim();
  }
  return "";
}

/** The settings files Claude reads for a session in `cwd`, most specific first. */
export function claudeSettingsFiles(cwd, env = process.env) {
  const user = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude");
  return [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json"),
    path.join(user, "settings.json")];
}

/** Each file parsed, or null for one that is missing or not JSON: an unreadable file names no model. */
export function readSettings(files) {
  return files.map((file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  });
}
