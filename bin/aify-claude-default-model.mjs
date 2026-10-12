#!/usr/bin/env node
// The model Claude Code would pick for a new session in a directory, read from its settings files.
//
//   aify-claude-default-model <cwd>
//
// Prints the model, or nothing when no settings file names one. Always exits 0: claude-aify then passes
// nothing, as it did before (lib/claude-default-model.mjs says why it asks).

import process from "node:process";

import { claudeDefaultModel, claudeSettingsFiles, readSettings } from "../lib/claude-default-model.mjs";
import { isMainModule } from "../lib/main-module.mjs";

if (isMainModule(import.meta.url)) {
  const model = claudeDefaultModel(readSettings(claudeSettingsFiles(process.argv[2] || process.cwd())));
  if (model) process.stdout.write(`${model}\n`);
}
