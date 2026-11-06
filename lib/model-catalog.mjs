// Only the curated modelPicker projection is read. settings.model is shared, not a selection receipt.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { effectivePolicy, parsePolicy, readSource } from "./channel-policy.mjs";
import { claudeConfigRoot } from "./claude-sessions.mjs";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const unresolved = (problem) => ({ rows: [], problem });

/** PURE. Forwarded settings can replace the native hook carrier; never override or merge them here. */
export function hasForwardedSettings(argv = []) {
  return argv.some((arg) => arg === "--settings" || arg.startsWith("--settings="));
}

/** PURE. A data-derived inverse only for a replacing, unique, explicitly labelled catalog. */
export function pickerCatalog(picker) {
  if (!picker || picker.replaceBuiltInOptions !== true || !Array.isArray(picker.options) || !picker.options.length) {
    return unresolved("no qualified replacing modelPicker catalog");
  }
  const models = new Set(), labels = new Set(), rows = [];
  for (const entry of picker.options) {
    if (!entry || typeof entry.model !== "string" || typeof entry.label !== "string") return unresolved("catalog row lacks a model or explicit label");
    const model = entry.model.trim(), label = entry.label.trim();
    if (!model || !label || model !== entry.model || label !== entry.label || CONTROL.test(model) || CONTROL.test(label) || label.endsWith(" (default)")) return unresolved("catalog row has an unsafe or reserved value");
    if (models.has(model) || labels.has(label)) return unresolved("catalog model or label is ambiguous");
    models.add(model); labels.add(label); rows.push(Object.freeze({ model, label }));
  }
  return { rows: Object.freeze(rows), problem: "" };
}

function readObject(file, read, absentAllowed = true) {
  try { return parsePolicy(read(file)); }
  catch (error) { return error.code === "ENOENT" && absentAllowed ? { ok: true, policy: {} } : { ok: false }; }
}

/** Read once at launch. Dependencies are explicit so tests never inspect the host's managed/user policy. */
export function readModelCatalog(options = {}) {
  const { argv = [], env = process.env, home = os.homedir(), platform = process.platform,
    ownSettings, read = (file) => fs.readFileSync(file, "utf8"), run = spawnSync,
    policyRead = (source) => readSource(source, { run: (command, argv, settings) => run(command, argv, { ...settings, timeout: 1000 }) }) } = options;
  if (hasForwardedSettings(argv)) return unresolved("forwarded --settings can replace the model scan hooks");
  const own = ownSettings ? readObject(ownSettings, read, false) : { ok: false };
  if (!own.ok || Object.hasOwn(own.policy, "modelPicker")) return unresolved("generated hook settings are not a picker-free carrier");

  let managed, forwardedManaged = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--managed-settings") { forwardedManaged = true; managed = argv[++i] ?? { unreadable: "missing managed settings" }; }
    else if (argv[i].startsWith("--managed-settings=")) { forwardedManaged = true; managed = argv[i].slice("--managed-settings=".length); }
  }
  if (!forwardedManaged) managed = Object.hasOwn(options, "managed") ? options.managed : effectivePolicy(platform, policyRead, env).text;
  if (forwardedManaged && (typeof managed !== "string" || !managed.trim())) return unresolved("managed settings cannot be read as a policy");
  const policy = parsePolicy(managed);
  if (!policy.ok) return unresolved("managed settings cannot be read as a policy");
  if (Object.hasOwn(policy.policy, "modelPicker")) return pickerCatalog(policy.policy.modelPicker);
  const userRoot = claudeConfigRoot({ env, home });
  const user = readObject(path.join(userRoot, "settings.json"), read);
  if (!user.ok) return unresolved("user picker settings are unreadable");
  return pickerCatalog(user.policy.modelPicker);
}
