// The Claude Code policy that admits aify's channel plugin without the development-channels prompt.
//
// Claude Code starts a channel with no warning only when MANAGED settings list it in
// `allowedChannelPlugins` (proven in a container, aify-comms docs/evidence/2026-10-22-channel-proof). The
// operator chose, 2026-10-22, a per-user policy on Windows: HKCU\SOFTWARE\Policies\ClaudeCode, value
// `Settings`, a JSON string, which needs no admin. Claude reads it only when no admin source exists.
//
// THE WRITE MERGES. That value is the operator's whole per-user policy, and `allowedChannelPlugins` replaces
// Anthropic's default list, so every other key and every other allowlist entry is kept. Malformed text is
// refused, never overwritten. An admin source present means the per-user value is ignored: that is
// reported, never written around. Removal takes out only our entry.
//
// The core is pure (text in, decision out). The adapters at the bottom are the only code that touches the
// machine, and no test runs them against the real registry.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const OUR_ENTRY = Object.freeze({ marketplace: "aify-local", plugin: "aify-channel" });
export const CHANNEL_SPEC = `plugin:${OUR_ENTRY.plugin}@${OUR_ENTRY.marketplace}`;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isOurs = (entry) => isPlainObject(entry) && entry.marketplace === OUR_ENTRY.marketplace && entry.plugin === OUR_ENTRY.plugin;

/** Parse policy text: absent is an empty policy; anything that is not a JSON object is refused. */
export function parsePolicy(text) {
  if (text === null || text === undefined || String(text).trim() === "") return { ok: true, policy: {} };
  try {
    const policy = JSON.parse(text);
    return isPlainObject(policy) ? { ok: true, policy } : { ok: false, reason: "the policy is not a JSON object" };
  } catch (error) {
    return { ok: false, reason: `the policy is not valid JSON: ${error.message}` };
  }
}

/** Does this policy admit our channel? Needs our entry, and channels not switched off. */
export function admitsOurChannel(policy) {
  if (!isPlainObject(policy) || policy.channelsEnabled === false) return false;
  return Array.isArray(policy.allowedChannelPlugins) && policy.allowedChannelPlugins.some(isOurs);
}

/** The policy with our entry added and channels enabled, everything else kept. */
export function withOurChannel(text) {
  const parsed = parsePolicy(text);
  if (!parsed.ok) return parsed;
  const policy = parsed.policy;
  if (policy.allowedChannelPlugins !== undefined && !Array.isArray(policy.allowedChannelPlugins)) {
    return { ok: false, reason: "allowedChannelPlugins is not a list" };
  }
  const list = policy.allowedChannelPlugins ?? [];
  const changed = !list.some(isOurs) || policy.channelsEnabled !== true;
  const next = { ...policy, channelsEnabled: true, allowedChannelPlugins: list.some(isOurs) ? list : [...list, { ...OUR_ENTRY }] };
  return { ok: true, changed, text: JSON.stringify(next) };
}

/**
 * The policy without our entry. `remove: true` means nothing else is left, so the whole value can go.
 * `channelsEnabled` is left as found: another plugin in the list may still need it.
 */
export function withoutOurChannel(text) {
  const parsed = parsePolicy(text);
  if (!parsed.ok) return parsed;
  const policy = parsed.policy;
  if (!Array.isArray(policy.allowedChannelPlugins) || !policy.allowedChannelPlugins.some(isOurs)) {
    return { ok: true, changed: false, remove: false, text: text ?? "" };
  }
  const list = policy.allowedChannelPlugins.filter((entry) => !isOurs(entry));
  const { allowedChannelPlugins: _drop, ...rest } = policy;
  const next = list.length ? { ...rest, allowedChannelPlugins: list } : rest;
  const onlyOurs = Object.keys(next).length === 0 || (Object.keys(next).length === 1 && next.channelsEnabled === true);
  return { ok: true, changed: true, remove: onlyOurs, text: JSON.stringify(next) };
}

/**
 * Where Claude reads managed settings on this platform, highest first. On Windows an admin source (the
 * HKLM value or the Program Files file) makes the per-user value ignored.
 */
export function policySources(platform) {
  if (platform === "win32") {
    return [
      { kind: "registry", hive: "HKLM", key: "HKLM\\SOFTWARE\\Policies\\ClaudeCode", admin: true },
      { kind: "file", path: "C:\\Program Files\\ClaudeCode\\managed-settings.json", admin: true },
      { kind: "registry", hive: "HKCU", key: "HKCU\\SOFTWARE\\Policies\\ClaudeCode", admin: false },
    ];
  }
  if (platform === "darwin") return [{ kind: "file", path: "/Library/Application Support/ClaudeCode/managed-settings.json", admin: true }];
  return [{ kind: "file", path: "/etc/claude-code/managed-settings.json", admin: true }];
}

/**
 * The effective policy: the first source holding text. `read(source)` returns the text, or null when the
 * source is absent. Returns which source answered, so a writer can see an admin source is in charge.
 */
export function effectivePolicy(platform, read) {
  for (const source of policySources(platform)) {
    const text = read(source);
    if (text !== null && text !== undefined && String(text).trim() !== "") return { source, text };
  }
  return { source: null, text: null };
}

/** What the install step does, decided from the effective policy and the per-user text. */
export function planInstall(platform, read) {
  const effective = effectivePolicy(platform, read);
  if (effective.source?.admin) {
    const parsed = parsePolicy(effective.text);
    return parsed.ok && admitsOurChannel(parsed.policy)
      ? { action: "none", reason: `the admin policy (${effective.source.key ?? effective.source.path}) already admits the channel` }
      : { action: "refuse", reason: `an admin policy (${effective.source.key ?? effective.source.path}) is in charge and does not admit the channel; the per-user value would be ignored` };
  }
  const user = policySources(platform).find((s) => !s.admin);
  if (!user) return { action: "refuse", reason: "this platform has no per-user policy; managed settings need admin here" };
  const merged = withOurChannel(read(user));
  if (!merged.ok) return { action: "refuse", reason: `the per-user policy was left as it is: ${merged.reason}` };
  return merged.changed ? { action: "write", source: user, text: merged.text } : { action: "none", reason: "the per-user policy already admits the channel" };
}

// ---- adapters: the only code here that touches the machine ----

/** Read a registry value `Settings` with reg.exe; null when the key or value is absent. */
export function readRegistrySettings(key, run = spawnSync) {
  // Through the shell on Windows, so `reg` is found on PATH as any command is (and a test's stub can stand in).
  const result = run("reg", ["query", `"${key}"`, "/v", "Settings"],
    { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
  if (result.status !== 0) return null;
  const line = String(result.stdout || "").split(/\r?\n/).find((l) => /^\s+Settings\s+REG_SZ\s/.test(l));
  return line ? line.replace(/^\s+Settings\s+REG_SZ\s+/, "") : null;
}

/** Read whichever source this is. */
export function readSource(source, { run = spawnSync, readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  if (source.kind === "registry") return readRegistrySettings(source.key, run);
  try { return readFile(source.path); } catch { return null; }
}

/** Write the per-user `Settings` value. The JSON travels in the environment, never in a command line. */
export function writeRegistrySettings(key, text, run = spawnSync) {
  const path = key.replace(/^HKCU\\/, "HKCU:\\");
  const script = `New-Item -Path '${path}' -Force | Out-Null; Set-ItemProperty -Path '${path}' -Name Settings -Type String -Value $env:AIFY_CHANNEL_POLICY`;
  const result = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, AIFY_CHANNEL_POLICY: text } });
  return result.status === 0 ? { ok: true } : { ok: false, reason: String(result.stderr || result.stdout || "powershell failed").trim() };
}

/** Delete the per-user `Settings` value. */
export function removeRegistrySettings(key, run = spawnSync) {
  const result = run("reg", ["delete", key, "/v", "Settings", "/f"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? { ok: true } : { ok: false, reason: String(result.stderr || result.stdout || "reg delete failed").trim() };
}
