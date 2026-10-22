#!/usr/bin/env node
// Installing the channel plugin removes the development route's user-scope server only after the policy
// admits the plugin and the plugin is installed, each read back. A step that fails stops there, and the
// development route still works.
//
// Every collaborator is a recording fake: no test writes the registry or runs the real claude.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { installChannel, MARKETPLACE_DIR, removeChannel } from "../lib/channel-install.mjs";
import { OUR_ENTRY, withOurChannel } from "../lib/channel-policy.mjs";

const HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";

/** A fake machine: a per-user policy value, a claude CLI that records, and a route answer. */
function machine({ policy = null, admin = null, writes = true, failing = [], route = "plugin" } = {}) {
  const state = { policy, calls: [], removedValue: false };
  return {
    state,
    platform: "win32",
    read: (source) => (source.admin ? admin : state.policy),
    write: (key, text) => { state.calls.push(`write ${key}`); if (writes) state.policy = text; return { ok: true }; },
    remove: (key) => { state.calls.push(`delete ${key}`); state.policy = null; return { ok: true }; },
    claude: (args) => { state.calls.push(`claude ${args.join(" ")}`); return { ok: !failing.some((f) => args.join(" ").startsWith(f)), out: "x" }; },
    route: () => ({ route, reason: route === "plugin" ? "" : "still the legacy server" }),
  };
}

test("the marketplace ships in the package, beside lib/", () => {
  assert.ok(fs.existsSync(path.join(MARKETPLACE_DIR, ".claude-plugin", "marketplace.json")), MARKETPLACE_DIR);
  const pkg = JSON.parse(fs.readFileSync(path.join(MARKETPLACE_DIR, "..", "..", "package.json"), "utf8"));
  assert.ok(pkg.files.includes("plugins/"), "npm would publish the package without the plugin");
});

test("install: policy, marketplace, plugin, and only then the legacy server", () => {
  const m = machine({ policy: JSON.stringify({ model: "opus" }) });
  const result = installChannel(m);
  assert.equal(result.ok, true, result.reason);
  const legacy = m.state.calls.indexOf("claude mcp remove --scope user aify-comms-channel");
  assert.deepEqual(m.state.calls.slice(0, legacy).map((c) => c.split(" ").slice(0, 3).join(" ")),
    [`write ${HKCU}`, "claude plugin marketplace", "claude plugin install"]);
  assert.equal(JSON.parse(m.state.policy).model, "opus", "the operator's policy is kept");
  assert.equal(m.state.calls[1], `claude plugin marketplace add ${MARKETPLACE_DIR}`);
});

test("a policy that already admits is not rewritten", () => {
  const m = machine({ policy: withOurChannel("").text });
  assert.equal(installChannel(m).ok, true);
  assert.ok(!m.state.calls.some((c) => c.startsWith("write")), m.state.calls.join("\n"));
});

for (const [name, setup, said] of [
  ["an admin policy that does not admit", { admin: JSON.stringify({ model: "x" }) }, /admin policy/],
  ["a write that does not read back", { writes: false }, /read back/],
  ["the marketplace add failing", { failing: ["plugin marketplace"] }, /marketplace add/],
  ["the plugin install failing", { failing: ["plugin install"] }, /plugin install/],
]) {
  test(`${name}: stops before the legacy server is touched`, () => {
    const m = machine(setup);
    const result = installChannel(m);
    assert.equal(result.ok, false);
    assert.match(result.reason, said);
    assert.ok(!m.state.calls.some((c) => c.includes("mcp remove")), m.state.calls.join("\n"));
  });
}

test("installed but the route still reads dev: reported as not done", () => {
  const result = installChannel(machine({ route: "dev" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /still dev/);
});

test("remove: only our entry goes, the whole value only when nothing else was in it", () => {
  const shared = machine({ policy: JSON.stringify({ model: "opus", allowedChannelPlugins: [OUR_ENTRY] }) });
  assert.equal(removeChannel(shared).ok, true);
  assert.deepEqual(JSON.parse(shared.state.policy), { model: "opus" });
  assert.ok(shared.state.calls.includes("claude plugin uninstall aify-channel@aify-local"));
  const ours = machine({ policy: withOurChannel("").text });
  assert.equal(removeChannel(ours).ok, true);
  assert.ok(ours.state.calls.includes(`delete ${HKCU}`), ours.state.calls.join("\n"));
  const malformed = machine({ policy: "{" });
  assert.equal(removeChannel(malformed).ok, false);
  assert.equal(malformed.state.policy, "{");
});
