#!/usr/bin/env node
// The Windows policy adapters read and write the per-user value EXACTLY, and fail closed on what they cannot read.
//
// Measured on this host's real registry, 2026-10-22 (docs/evidence/2026-10-22-channel-winproof): `reg query` prints a
// value through the console code page, so "naïve" came back "naive" and "ключ" came back "????", with exit 0; the
// install then wrote that text back over the operator's policy. `New-Item -Force` on an existing key deleted its
// other values. A `Settings` value of another type read as absent, and the install replaced it. Each is a loss of
// the operator's policy, so each has a check here. Recording fakes only: no test touches the real registry.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePolicy, planInstall, policySources, readRegistrySettings, readSource, settingsFromRegExport,
  writeRegistrySettings } from "../lib/channel-policy.mjs";

const HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
const HEADER = "[HKEY_CURRENT_USER\\SOFTWARE\\Policies\\ClaudeCode]";
const exportText = (...lines) => ["Windows Registry Editor Version 5.00", "", ...lines, "", ""].join("\r\n");

test("the export parser returns the Settings string exactly: unicode, quotes, backslashes, newlines", () => {
  const value = "{\n  \"naïve ключ\": \"日本 \\\" ' \\\\ ✓\",\n  \"list\": [\n[1]\n]\n}";
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const text = exportText(HEADER, `"Other"="x"`, `"Settings"="${escaped}"`, "",
    `${HEADER.slice(0, -1)}\\child]`, `"Settings"="child"`);
  assert.equal(settingsFromRegExport(text, HKCU), value);
});

test("the value name is matched as Windows matches it, without case; two spellings refuse", () => {
  // Windows keeps a value's first spelling and treats every other as the same value (measured on a scratch key,
  // 2026-10-23: `reg add /v SETTINGS` and SetValue('Settings') both rewrote an existing `settings`, keeping its name).
  // Read case-sensitively, `settings` was absent and the install wrote only our entry over the operator's policy.
  assert.equal(settingsFromRegExport(exportText(HEADER, `"settings"="{\\"model\\":\\"x\\"}"`), HKCU), "{\"model\":\"x\"}");
  assert.equal(settingsFromRegExport(exportText(HEADER, `"SETTINGS"="{}"`), HKCU), "{}");
  const plan = planInstall("win32", (s) => (s.key === HKCU ? settingsFromRegExport(exportText(HEADER, `"settings"="{\\"model\\":\\"x\\"}"`), HKCU) : null), { ProgramFiles: "C:\\PF" });
  assert.equal(plan.action, "write");
  assert.equal(JSON.parse(plan.text).model, "x", "the operator's value is merged, not replaced");
  const two = settingsFromRegExport(exportText(HEADER, `"settings"="{}"`, `"Settings"="{}"`), HKCU);
  assert.ok(two?.unreadable, JSON.stringify(two));
});

test("the export parser: no Settings is absent; a subkey's Settings is not ours; the header matches regardless of case", () => {
  assert.equal(settingsFromRegExport(exportText(HEADER, `"Other"="x"`), HKCU), null);
  assert.equal(settingsFromRegExport(exportText(HEADER, "", `${HEADER.slice(0, -1)}\\child]`, `"Settings"="{}"`), HKCU), null);
  assert.equal(settingsFromRegExport(exportText(HEADER.toLowerCase(), `"Settings"="{}"`), HKCU), "{}");
});

test("a Settings value of another type, or text the parser cannot read, is unreadable and refuses the install", () => {
  for (const line of [`"Settings"=hex(2):7b,00,7d,00,00,00`, `"Settings"=dword:00000001`, `"Settings"="a \\q"`, `"Settings"="unterminated`]) {
    const read = settingsFromRegExport(exportText(HEADER, line), HKCU);
    assert.equal(typeof read, "object", line);
    assert.ok(read?.unreadable, line);
    assert.equal(parsePolicy(read).ok, false, line);
    assert.match(parsePolicy(read).reason, /could not be read/, line);
    const plan = planInstall("win32", (s) => (s.key === HKCU ? read : null), { ProgramFiles: "C:\\PF" });
    assert.equal(plan.action, "refuse", line);
  }
});

/** A stand-in for spawnSync that writes `exported` to the export's file argument, as `reg export` does. */
function regExport({ status = 0, exported = null, stderr = "" } = {}) {
  const calls = [];
  const files = new Map();
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (exported !== null) files.set(args[2].replace(/^"|"$/g, ""), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(exported, "utf16le")]));
    return { status, stdout: "", stderr };
  };
  const io = { readFile: (file) => { if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(file); },
    remove: (file) => files.delete(file) };
  return { calls, run, io, files };
}

test("the registry reader exports the key and decodes UTF-16, and removes its temporary file", () => {
  const value = "{\"naïve ключ\":\"日本 ✓\"}";
  const fake = regExport({ exported: exportText(HEADER, `"Settings"="${value.replace(/"/g, "\\\"")}"`) });
  assert.equal(readRegistrySettings(HKCU, fake.run, fake.io), value);
  assert.equal(fake.calls[0].command, "reg");
  assert.deepEqual(fake.calls[0].args.slice(0, 2), ["export", `"${HKCU}"`]);
  assert.equal(fake.calls[0].args[3], "/y");
  assert.equal(fake.files.size, 0, "the export file is removed");
});

test("the registry reader: a missing key is absent; any other failure is unreadable, never absent", () => {
  const missing = regExport({ status: 1, stderr: "ERROR: The system was unable to find the specified registry key or value." });
  assert.equal(readRegistrySettings(HKCU, missing.run, missing.io), null);
  const denied = regExport({ status: 1, stderr: "ERROR: Access is denied." });
  const read = readRegistrySettings(HKCU, denied.run, denied.io);
  assert.ok(read?.unreadable, JSON.stringify(read));
  const noFile = regExport({ status: 0 });
  assert.ok(readRegistrySettings(HKCU, noFile.run, noFile.io)?.unreadable, "exit 0 with no file is not absent");
});

test("an admin file that exists but cannot be read is unreadable, not absent", () => {
  const source = policySources("win32", { ProgramFiles: "C:\\PF" })[1];
  const enoent = readSource(source, { readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
  assert.equal(enoent, null);
  const eacces = readSource(source, { readFile: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } });
  assert.ok(eacces?.unreadable, JSON.stringify(eacces));
  const plan = planInstall("win32", (s) => (s.admin && s.kind === "file" ? eacces : null), { ProgramFiles: "C:\\PF" });
  assert.equal(plan.action, "refuse");
});

test("the registry writer opens the key without replacing it, and passes the key and the JSON in the environment", () => {
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  const text = JSON.stringify({ note: "it's \"quoted\" ✓" });
  assert.deepEqual(writeRegistrySettings(HKCU, text, run), { ok: true });
  const script = calls[0].args.join(" ");
  assert.doesNotMatch(script, /New-Item/i, "New-Item -Force on an existing key deletes its other values");
  assert.match(script, /CreateSubKey/);
  assert.match(script, /RegistryValueKind\]::String/);
  assert.equal(calls[0].options.env.AIFY_CHANNEL_POLICY, text);
  assert.equal(calls[0].options.env.AIFY_CHANNEL_POLICY_SUBKEY, "SOFTWARE\\Policies\\ClaudeCode");
  assert.ok(!script.includes("Policies"), "neither the key nor the JSON is on the command line");
});

test("the registry writer refuses any hive but the current user's", () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  const result = writeRegistrySettings("HKLM\\SOFTWARE\\Policies\\ClaudeCode", "{}", run);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("an admin drop-in directory holding policy files is present: the install refuses rather than write a value Claude ignores", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const dir = policySources(platform, { ProgramFiles: "C:\\PF" }).find((s) => s.kind === "dir");
    assert.ok(dir?.admin, platform);
    const withDrops = (s) => (s.kind === "dir" ? readSource(s, { readDir: () => ["10-team.json", "notes.txt"] }) : null);
    assert.equal(planInstall(platform, withDrops, { ProgramFiles: "C:\\PF" }).action, "refuse", platform);
    const empty = (s) => (s.kind === "dir" ? readSource(s, { readDir: () => ["notes.txt"] }) : null);
    assert.equal(readSource(dir, { readDir: () => ["notes.txt"] }), null, `${platform}: no .json file is no policy`);
    assert.equal(readSource(dir, { readDir: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }), null);
    assert.ok(readSource(dir, { readDir: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } })?.unreadable);
    if (platform === "win32") assert.equal(planInstall(platform, empty, { ProgramFiles: "C:\\PF" }).action, "write");
  }
});
