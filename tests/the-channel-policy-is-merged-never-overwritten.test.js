#!/usr/bin/env node
// The per-user Claude Code policy that admits aify's channel is merged into, never overwritten.
//
// That value is the operator's whole per-user policy, and `allowedChannelPlugins` replaces Anthropic's
// default channel list, so a write that kept only our entry would silently switch off every other channel
// the operator allows (operator's ruling, 2026-10-22). An admin source in charge makes the per-user value
// ignored: the writer reports it and writes nothing. Removal takes out only our entry.
//
// Every adapter here runs against a recording fake: no test touches the real registry. The registry reader and
// writer have their own file, the-windows-policy-is-read-and-written-exactly.test.js.

import assert from "node:assert/strict";
import { test } from "node:test";

import { admitsOurChannel, CHANNEL_SPEC, effectivePolicy, OUR_ENTRY, parsePolicy, planInstall, policySources,
  readSource, removeRegistrySettings, withOurChannel, withoutOurChannel } from "../lib/channel-policy.mjs";

const OTHER = { marketplace: "claude-plugins-official", plugin: "telegram" };
const HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";

test("the spec claude-aify passes names our entry", () => {
  assert.equal(CHANNEL_SPEC, `plugin:${OUR_ENTRY.plugin}@${OUR_ENTRY.marketplace}`);
  assert.equal(CHANNEL_SPEC, "plugin:aify-channel@aify-local");
});

test("an absent policy is empty; text that is not a JSON object is refused, not treated as empty", () => {
  assert.deepEqual(parsePolicy(null), { ok: true, policy: {} });
  assert.deepEqual(parsePolicy("  "), { ok: true, policy: {} });
  for (const bad of ["{", "[]", "3", "\"x\""]) assert.equal(parsePolicy(bad).ok, false, bad);
});

test("the merge keeps every other key and every other allowlist entry, and adds ours once", () => {
  const before = JSON.stringify({ model: "opus", allowedChannelPlugins: [OTHER], permissions: { deny: ["x"] } });
  const merged = withOurChannel(before);
  assert.equal(merged.ok, true);
  assert.equal(merged.changed, true);
  const after = JSON.parse(merged.text);
  assert.equal(after.model, "opus");
  assert.deepEqual(after.permissions, { deny: ["x"] });
  assert.deepEqual(after.allowedChannelPlugins, [OTHER, OUR_ENTRY]);
  assert.equal(after.channelsEnabled, true);
  assert.equal(admitsOurChannel(after), true);
  const again = withOurChannel(merged.text);
  assert.equal(again.changed, false, "a second install changes nothing");
  assert.deepEqual(JSON.parse(again.text).allowedChannelPlugins, [OTHER, OUR_ENTRY]);
});

test("the merge refuses what it cannot merge, rather than replacing it", () => {
  assert.equal(withOurChannel("not json").ok, false);
  assert.equal(withOurChannel(JSON.stringify({ allowedChannelPlugins: "telegram" })).ok, false);
});

test("channels switched off, or our entry missing, does not admit the channel", () => {
  assert.equal(admitsOurChannel({ channelsEnabled: false, allowedChannelPlugins: [OUR_ENTRY] }), false);
  assert.equal(admitsOurChannel({ channelsEnabled: true, allowedChannelPlugins: [OTHER] }), false);
  assert.equal(admitsOurChannel({ allowedChannelPlugins: [OUR_ENTRY] }), true);
  // A switched-off policy is switched back on by an install: the operator asked for the channel.
  assert.equal(JSON.parse(withOurChannel(JSON.stringify({ channelsEnabled: false, allowedChannelPlugins: [OUR_ENTRY] })).text).channelsEnabled, true);
});

test("removal takes out only our entry, and the whole value only when nothing else is in it", () => {
  const shared = withoutOurChannel(JSON.stringify({ model: "opus", channelsEnabled: true, allowedChannelPlugins: [OTHER, OUR_ENTRY] }));
  assert.equal(shared.remove, false);
  assert.deepEqual(JSON.parse(shared.text), { model: "opus", channelsEnabled: true, allowedChannelPlugins: [OTHER] });
  assert.equal(withoutOurChannel(withOurChannel("").text).remove, true);
  assert.equal(withoutOurChannel(JSON.stringify({ model: "opus" })).changed, false);
  assert.equal(withoutOurChannel("{").ok, false);
});

const reader = (values) => (source) => values[source.key ?? source.path] ?? null;

test("on Windows an admin source outranks the per-user value", () => {
  const sources = policySources("win32");
  assert.deepEqual(sources.map((s) => s.admin), [true, true, true, false]);
  assert.deepEqual(sources.map((s) => s.kind), ["registry", "file", "dir", "registry"]);
  assert.equal(sources[3].key, HKCU);
  const fileText = JSON.stringify({ model: "x" });
  const answer = effectivePolicy("win32", reader({ [sources[1].path]: fileText, [HKCU]: "{}" }));
  assert.deepEqual(answer.source, sources[1]);
  assert.equal(answer.text, fileText);
  assert.deepEqual(effectivePolicy("win32", reader({})), { source: null, text: null });
});

test("install writes the merged per-user value, does nothing when it already admits, refuses under an admin source", () => {
  const plan = planInstall("win32", reader({ [HKCU]: JSON.stringify({ allowedChannelPlugins: [OTHER] }) }));
  assert.equal(plan.action, "write");
  assert.equal(plan.source.key, HKCU);
  assert.deepEqual(JSON.parse(plan.text).allowedChannelPlugins, [OTHER, OUR_ENTRY]);
  assert.equal(planInstall("win32", reader({ [HKCU]: plan.text })).action, "none");
  const hklm = policySources("win32")[0].key;
  assert.equal(planInstall("win32", reader({ [hklm]: JSON.stringify({ model: "x" }) })).action, "refuse");
  assert.equal(planInstall("win32", reader({ [hklm]: plan.text })).action, "none");
  assert.equal(planInstall("win32", reader({ [HKCU]: "{" })).action, "refuse", "a malformed per-user value is left alone");
});

test("the admin file is found through Program Files, and not knowing where that is refuses the install", () => {
  const file = policySources("win32", { ProgramFiles: "D:\\Apps" })[1];
  assert.deepEqual(file, { kind: "file", path: "D:\\Apps\\ClaudeCode\\managed-settings.json", admin: true }); // example path
  const plan = planInstall("win32", reader({}), {});
  assert.equal(plan.action, "refuse");
  assert.match(plan.reason, /cannot tell whether an admin policy exists/);
  assert.equal(readSource(policySources("win32", {})[1]), null, "an unknown location is never read as a file");
});

for (const platform of ["linux", "darwin"]) test(`${platform}: only an absent managed policy can be prepared`, () => {
    const absent = planInstall(platform, reader({}));
    assert.equal(absent.action, "prepare", "a genuinely absent POSIX policy needs the explicit policy-only operation");
    const file = policySources(platform)[0].path;
    assert.equal(absent.source.path, file);
    assert.equal(planInstall(platform, reader({ [file]: withOurChannel("").text })).action, "none", platform);
    for (const existing of ["", "  ", "{}", "{", JSON.stringify({ channelsEnabled: false })]) {
      assert.equal(planInstall(platform, reader({ [file]: existing })).action, "refuse", "an existing file is never an absent-policy bootstrap");
    }
});

/** A recording stand-in for spawnSync. */
function recorder(result) {
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return result; };
  return { calls, run };
}

test("a policy file is read as text, and the per-user value is deleted with reg (the registry reader and writer: the-windows-policy-is-read-and-written-exactly)", () => {
  assert.equal(readSource({ kind: "file", path: "/p" }, { readFile: (p) => `read ${p}` }), "read /p");
  const removed = recorder({ status: 0 });
  assert.deepEqual(removeRegistrySettings(HKCU, removed.run), { ok: true });
  assert.deepEqual(removed.calls[0].args, ["delete", HKCU, "/v", "Settings", "/f"]);
  assert.equal(removeRegistrySettings(HKCU, recorder({ status: 1, stderr: "gone" }).run).ok, false);
});
