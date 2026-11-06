// Catalog projection pins authority/ambiguity rules, not a second settings loader or shared settings.model timing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readModelCatalog } from "../lib/model-catalog.mjs";

const picker = (model, label = "Visible name") => ({ modelPicker: { replaceBuiltInOptions: true, options: [{ model, label }] } });
function world(t, user = picker("provider/user")) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-model-catalog-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "custom-config"); fs.mkdirSync(root);
  const file = path.join(root, "settings.json"); fs.writeFileSync(file, JSON.stringify(user));
  const own = path.join(home, "hooks.json"); fs.writeFileSync(own, JSON.stringify({ hooks: {} }));
  const options = { home, env: { CLAUDE_CONFIG_DIR: root }, cwd: home, argv: [], ownSettings: own, managed: null };
  return { home, root, file, own, options, load: (extra = {}) => readModelCatalog({ ...options, ...extra }) };
}

test("a unique user catalog is read from the selected config home, not settings.model", (t) => {
  const w = world(t, { ...picker("provider/user"), model: "WRONG-SHARED-MODEL" });
  assert.deepEqual(w.load(), { rows: [{ model: "provider/user", label: "Visible name" }], problem: "" });
});

test("present managed picker outranks user picker; no merging", (t) => {
  const w = world(t);
  const result = w.load({ managed: JSON.stringify(picker("provider/managed")) });
  assert.deepEqual(result.rows, [{ model: "provider/managed", label: "Visible name" }]);
  assert.equal(result.problem, "");
});

test("even readable forwarded settings leave command reporting unsupported without merging hooks", (t) => {
  const w = world(t); const file = path.join(w.home, "cli.json"); fs.writeFileSync(file, JSON.stringify(picker("provider/cli")));
  const result = w.load({ argv: ["--settings=cli.json"] });
  assert.match(result.problem, /forwarded --settings/);
  assert.deepEqual(result.rows, []);
});

test("parseable managed settings without a picker do not hide the user picker", (t) => {
  const w = world(t);
  assert.equal(w.load({ managed: JSON.stringify({ allowedChannelPlugins: [] }) }).rows[0]?.model, "provider/user");
});

test("explicit SDK managed-settings JSON participates at managed priority", (t) => {
  const w = world(t);
  assert.equal(w.load({ argv: ["--managed-settings", JSON.stringify(picker("provider/sdk"))] }).rows[0]?.model, "provider/sdk");
});

for (const [name, extra] of [
  ["unreadable managed", { managed: { unreadable: "policy unavailable" } }],
  ["invalid managed", { managed: "not json" }],
  ["unreadable forwarded", { argv: ["--settings", "missing.json"] }],
  ["invalid SDK managed", { argv: ["--managed-settings", "not json"] }],
  ["empty SDK managed", { argv: ["--managed-settings="] }],
]) {
  test(`${name}: unresolved rather than silently using lower-priority user data`, (t) => {
    const w = world(t); const result = w.load(extra);
    assert.notEqual(result.problem, ""); assert.deepEqual(result.rows, []);
  });
}

for (const [name, user] of [
  ["only shared model", { model: "provider/not-a-receipt" }],
  ["non-replacing catalog", { modelPicker: { options: [{ model: "provider/a", label: "A" }] } }],
  ["duplicate label", { modelPicker: { replaceBuiltInOptions: true, options: [{ model: "a", label: "A" }, { model: "b", label: "A" }] } }],
  ["duplicate model", { modelPicker: { replaceBuiltInOptions: true, options: [{ model: "a", label: "A" }, { model: "a", label: "B" }] } }],
  ["reserved default suffix", picker("a", "A (default)")],
  ["control character", picker("bad\nmodel", "A")],
  ["whitespace-padded model", picker(" provider/exact ", "A")],
  ["whitespace-padded label", picker("provider/exact", " A ")],
]) {
  test(`${name}: no unqualified inverse mapping`, (t) => {
    const w = world(t, user); const result = w.load();
    assert.notEqual(result.problem, ""); assert.deepEqual(result.rows, []);
  });
}

test("own hook-settings carrier must not declare a modelPicker", (t) => {
  const w = world(t); fs.writeFileSync(w.own, JSON.stringify(picker("provider/hidden")));
  assert.notEqual(w.load().problem, "");
});

test("frozen projection owns its rows and never rereads later shared settings.model", (t) => {
  const w = world(t); const first = w.load();
  fs.writeFileSync(w.file, JSON.stringify({ ...picker("provider/changed"), model: "provider/not-selected" }));
  assert.equal(first.rows[0]?.model, "provider/user");
  assert.equal(w.load().rows[0]?.model, "provider/changed");
});
