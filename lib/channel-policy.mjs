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
// machine. No test runs them against the real registry; docs/evidence/2026-10-22-channel-winproof/probe.mjs does,
// against a scratch key.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OUR_ENTRY = Object.freeze({ marketplace: "aify-local", plugin: "aify-channel" });
export const CHANNEL_SPEC = `plugin:${OUR_ENTRY.plugin}@${OUR_ENTRY.marketplace}`;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isOurs = (entry) => isPlainObject(entry) && entry.marketplace === OUR_ENTRY.marketplace && entry.plugin === OUR_ENTRY.plugin;

/**
 * Parse policy text: absent is an empty policy; anything that is not a JSON object is refused, and so is a source
 * an adapter could not read (`{ unreadable }`), which is never taken for absent.
 */
export function parsePolicy(text) {
  if (isPlainObject(text) && text.unreadable) return { ok: false, reason: `the policy could not be read: ${text.unreadable}` };
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
 * HKLM value, the Program Files file, or its `managed-settings.d` drop-ins) makes the per-user value ignored
 * (code.claude.com/docs/en/managed-settings, "How Claude Code combines managed sources", read 2026-10-22).
 * Remote (server-managed) settings rank above all of these and cannot be seen from here.
 */
export function policySources(platform, env = process.env) {
  if (platform === "win32") {
    // The admin files live in Program Files, wherever this machine keeps it. Not knowing where is not "absent".
    const programFiles = env.ProgramFiles || env.PROGRAMFILES;
    const inProgramFiles = (kind, name) => (programFiles
      ? { kind, path: path.win32.join(programFiles, "ClaudeCode", name), admin: true }
      : { kind: "unknown", path: `%ProgramFiles%\\ClaudeCode\\${name}`, admin: true });
    return [
      { kind: "registry", hive: "HKLM", key: "HKLM\\SOFTWARE\\Policies\\ClaudeCode", admin: true },
      inProgramFiles("file", "managed-settings.json"),
      inProgramFiles("dir", "managed-settings.d"),
      { kind: "registry", hive: "HKCU", key: "HKCU\\SOFTWARE\\Policies\\ClaudeCode", admin: false },
    ];
  }
  const dir = platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
  return [
    { kind: "file", path: `${dir}/managed-settings.json`, admin: true },
    { kind: "dir", path: `${dir}/managed-settings.d`, admin: true },
  ];
}

/**
 * The effective policy: the first source present. `read(source)` returns the text, null when the source is absent, or
 * `{ unreadable }`. Returns which source answered, so a writer can see an admin source is in charge.
 *
 * Presence is the source's own (code.claude.com/docs/en/managed-settings, read 2026-10-22): an empty HKLM `Settings`
 * is malformed admin policy, on which Claude refuses to start, while an empty file or HKCU value is no policy. The
 * admin file and its `managed-settings.d` drop-ins are ONE source, merged by Claude with the drop-ins overriding, so
 * drop-ins present (which this reader does not merge) answer for that source even when the base file admits.
 */
export function effectivePolicy(platform, read, env = process.env) {
  const answers = policySources(platform, env).map((source) => ({ source, text: read(source) }));
  const blank = (text) => typeof text === "string" && text.trim() === "";
  const present = ({ source, text }) => text !== null && text !== undefined && (!blank(text) || (source.kind === "registry" && source.admin));
  const dropIns = answers.find((answer) => answer.source.kind === "dir" && present(answer));
  for (const answer of answers) {
    // An admin location this host cannot find (no Program Files) is not absent: what it holds is unknown.
    if (answer.source.kind === "unknown") {
      return { source: answer.source, text: { unreadable: `cannot tell whether an admin policy exists at ${answer.source.path}` } };
    }
    if (!present(answer)) continue;
    if (answer.source.kind === "file" && dropIns) return dropIns;
    if (blank(answer.text)) {
      return { source: answer.source, text: { unreadable: `${answer.source.key} Settings is empty, which Claude reads as malformed admin policy` } };
    }
    return answer;
  }
  return { source: null, text: null };
}

/** What the install step does, decided from the effective policy and the per-user text. */
export function planInstall(platform, read, env = process.env) {
  const unknown = policySources(platform, env).find((s) => s.kind === "unknown");
  if (unknown) return { action: "refuse", reason: `cannot tell whether an admin policy exists at ${unknown.path}` };
  const effective = effectivePolicy(platform, read, env);
  if (effective.source?.admin) {
    const parsed = parsePolicy(effective.text);
    return parsed.ok && admitsOurChannel(parsed.policy)
      ? { action: "none", reason: `the admin policy (${effective.source.key ?? effective.source.path}) already admits the channel` }
      : { action: "refuse", reason: `an admin policy (${effective.source.key ?? effective.source.path}) is in charge and does not admit the channel; the per-user value would be ignored` };
  }
  const user = policySources(platform, env).find((s) => !s.admin);
  if (!user) return { action: "refuse", reason: "this platform has no per-user policy; managed settings need admin here" };
  const merged = withOurChannel(read(user));
  if (!merged.ok) return { action: "refuse", reason: `the per-user policy was left as it is: ${merged.reason}` };
  return merged.changed ? { action: "write", source: user, text: merged.text } : { action: "none", reason: "the per-user policy already admits the channel" };
}

// ---- the registry export, parsed: pure ----

const HIVES = { HKCU: "HKEY_CURRENT_USER", HKLM: "HKEY_LOCAL_MACHINE" };
const longKey = (key) => key.replace(/^(HKCU|HKLM)\\/i, (_, hive) => `${HIVES[hive.toUpperCase()]}\\`);

/**
 * The `Settings` string of `key` out of `reg export` text (already decoded), exactly as stored. Null when the key's
 * own section has no `Settings`. `{ unreadable }` when it holds another type, or text this parser cannot read: a
 * value it cannot read is never taken for absent. A `.reg` string escapes only `\\` and `\"`, and may span lines.
 */
export function settingsFromRegExport(text, key) {
  const header = `[${longKey(key)}]`.toLowerCase();
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === header);
  if (start < 0) return { unreadable: `the export of ${key} has no section for it` };
  const body = lines.slice(start + 1).join("\n");
  let at = 0;
  const readString = () => { // at the opening quote; returns the unescaped string, or null when malformed
    let out = "";
    for (at += 1; at < body.length; at += 1) {
      const ch = body[at];
      if (ch === "\"") { at += 1; return out; }
      if (ch === "\\") {
        const next = body[at + 1];
        if (next !== "\\" && next !== "\"") return null;
        out += next;
        at += 1;
      } else {
        out += ch;
      }
    }
    return null;
  };
  const skipLine = () => { // past a non-string value, following `\` continuations
    for (;;) {
      const end = body.indexOf("\n", at);
      const line = end < 0 ? body.slice(at) : body.slice(at, end);
      at = end < 0 ? body.length : end + 1;
      if (!line.trimEnd().endsWith("\\") || end < 0) return;
    }
  };
  let found;
  while (at < body.length) {
    while (body[at] === "\n" || body[at] === " ") at += 1;
    if (at >= body.length || body[at] === "[") break;
    let name;
    if (body[at] === "@") { name = null; at += 1; } else if (body[at] === "\"") {
      name = readString();
      if (name === null) return { unreadable: `the export of ${key} has a value name this reader cannot parse` };
    } else {
      return { unreadable: `the export of ${key} has a line this reader cannot parse` };
    }
    if (body[at] !== "=") return { unreadable: `the export of ${key} has a line this reader cannot parse` };
    at += 1;
    // Windows matches value names without case and keeps the first spelling, so `settings` is the value Claude reads.
    const isSettings = typeof name === "string" && name.toLowerCase() === "settings";
    if (isSettings && found !== undefined) return { unreadable: `${key} holds Settings under two spellings` };
    if (body[at] === "\"") {
      const value = readString();
      if (value === null) {
        if (isSettings) return { unreadable: `${key} ${name} is not a string this reader can parse` };
        return { unreadable: `the export of ${key} has a string this reader cannot parse` };
      }
      if (isSettings) found = value;
    } else {
      if (isSettings) found = { unreadable: `${key} ${name} is not a plain string (REG_SZ)` };
      skipLine();
    }
  }
  return found ?? null;
}

// ---- adapters: the only code here that touches the machine ----

const NOT_FOUND = /unable to find the specified registry key/i;

/**
 * Read the `Settings` value of a registry key exactly. `reg query` is not exact: it prints through the console code
 * page, so non-ASCII text came back altered with exit 0 (measured 2026-10-22). `reg export` writes UTF-16 to a
 * file. Null when the key or the value is absent; `{ unreadable }` on any other failure.
 */
export function readRegistrySettings(key, run = spawnSync, io = { readFile: (f) => fs.readFileSync(f), remove: (f) => fs.rmSync(f, { force: true }) }) {
  const file = path.join(os.tmpdir(), `aify-channel-policy-${process.pid}-${randomUUID()}.reg`);
  try {
    // Through the shell on Windows, so `reg` is found on PATH as any command is (and a test's stub can stand in);
    // the shell joins arguments as written, so both are quoted.
    const result = run("reg", ["export", `"${key}"`, `"${file}"`, "/y"],
      { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
    if (result.status !== 0) {
      const said = String(result.stderr || result.stdout || "").trim();
      return NOT_FOUND.test(said) ? null : { unreadable: `reg export ${key} failed: ${said || `exit ${result.status}`}` };
    }
    let bytes;
    try { bytes = io.readFile(file); } catch (error) { return { unreadable: `reg export ${key} wrote no file: ${error.message}` }; }
    const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
    return settingsFromRegExport(utf16 ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8"), key);
  } finally {
    try { io.remove(file); } catch { /* a leftover temporary file holds only what the policy already says */ }
  }
}

/** Read whichever source this is. A file that exists but cannot be read is `{ unreadable }`, never absent. */
export function readSource(source, { run = spawnSync, readFile = (p) => fs.readFileSync(p, "utf8"),
  readDir = (p) => fs.readdirSync(p) } = {}) {
  if (source.kind === "registry") return readRegistrySettings(source.key, run);
  if (source.kind === "dir") return dropInsOf(source.path, readDir);
  if (source.kind !== "file") return null;
  try {
    return readFile(source.path);
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : { unreadable: `${source.path}: ${error?.message ?? error}` };
  }
}

/**
 * Claude merges `managed-settings.d/*.json` with the admin file. This installer does not merge them, so a directory
 * holding any is an admin source it cannot read: present, never absent, and the install refuses.
 */
function dropInsOf(dir, readDir) {
  let names;
  try {
    names = readDir(dir);
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : { unreadable: `${dir}: ${error?.message ?? error}` };
  }
  const drops = names.filter((name) => /\.json$/i.test(String(name)));
  return drops.length ? { unreadable: `${dir} holds drop-in policy files (${drops.join(", ")}), which this installer does not merge` } : null;
}

/**
 * Write the per-user `Settings` value as a string, keeping every other value under the key. CreateSubKey opens an
 * existing key as it is; `New-Item -Force` replaced it, deleting its other values (measured 2026-10-22). The key and
 * the JSON travel in the environment, never in a command line. Only the current user's hive is written.
 */
export function writeRegistrySettings(key, text, run = spawnSync) {
  const sub = /^HKCU\\(.+)$/i.exec(key)?.[1];
  if (!sub) return { ok: false, reason: `${key} is not under HKCU; only the per-user policy is written` };
  const script = "$ErrorActionPreference = 'Stop'; try { "
    + "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:AIFY_CHANNEL_POLICY_SUBKEY); "
    + "$k.SetValue('Settings', $env:AIFY_CHANNEL_POLICY, [Microsoft.Win32.RegistryValueKind]::String); $k.Close() "
    + "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
  const result = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, AIFY_CHANNEL_POLICY: text, AIFY_CHANNEL_POLICY_SUBKEY: sub } });
  return result.status === 0 ? { ok: true } : { ok: false, reason: String(result.stderr || result.stdout || "powershell failed").trim() };
}

/** Delete the per-user `Settings` value. */
export function removeRegistrySettings(key, run = spawnSync) {
  const result = run("reg", ["delete", key, "/v", "Settings", "/f"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? { ok: true } : { ok: false, reason: String(result.stderr || result.stdout || "reg delete failed").trim() };
}
