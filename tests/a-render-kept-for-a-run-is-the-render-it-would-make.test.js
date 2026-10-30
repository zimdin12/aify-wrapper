// tests/launch-to-a-stub-runtime.mjs keeps each render for the run and copies it into later launches with the same
// inputs (the render cache). This is where it is proved not to change what a launch tests: a kept render, copied into a
// world, is byte for byte the render install.sh makes there, once the one directory name that differs is the same; an
// edit stays in its own launch; and the key changes with every input a render is made from. It also keeps one fresh
// render per client in the run, so a cache cannot hide a render that broke.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { launch, renderKey } from "./launch-to-a-stub-runtime.mjs";

const REGISTRY = { version: 1, services: { "aify-dashboard": {
  endpoint: "http://127.0.0.2:9700", sessionInject: { mcp: true }, mcp: [{ name: "aify-dashboard", command: "node", args: ["/d/bridge.mjs"] }] } } };
const env = (client) => (client === "pi" ? { AIFY_PI_COMMAND: "pi" } : {});

/** The launcher text a launch ran, and the directory its world was in. */
function rendered(client, options) {
  let text = "";
  const result = launch(client, [], { env: env(client), registry: REGISTRY, ...options,
    edit: (got) => { text = got; return options.edit ? options.edit(got) : got; } });
  return { text, world: path.basename(path.dirname(path.dirname(result.launcher))), made: result.render };
}

for (const client of ["claude", "codex", "hermes", "pi"]) {
  test(`${client}: a kept render is the render install.sh makes, but for its world's directory`, () => {
    rendered(client, {}); // keeps the render, made in a world of its own, unless an earlier launch kept it
    const fresh = rendered(client, { fresh: true }); // renders, though a render is kept
    const kept = rendered(client, {}); // copies it
    assert.deepEqual([fresh.made, kept.made], ["rendered", "kept"], "a fresh launch was served the kept render, or a kept one was not used");
    assert.ok(fresh.text.includes(fresh.world), "control: the render does not name its world, so the comparison proves nothing");
    assert.notEqual(fresh.world, kept.world);
    assert.equal(kept.text, fresh.text.split(fresh.world).join(kept.world), "a kept render differs from a fresh one");
  });
}

test("an edit to a kept render stays in its own launch", () => {
  const edited = rendered("claude", { edit: (text) => `${text}\n# edited by one launch\n` });
  assert.ok(edited.text.length > 0);
  const next = rendered("claude", {});
  assert.doesNotMatch(next.text, /edited by one launch/);
});

test("a launch with another registry is never handed a render kept for this one", () => {
  const withServices = rendered("claude", {});
  const without = rendered("claude", { registry: { version: 1, services: {} } });
  const freshWithout = rendered("claude", { registry: { version: 1, services: {} }, fresh: true });
  assert.notEqual(withServices.text.split(withServices.world).join(without.world), without.text,
    "control: the two registries render the same launcher, so this proves nothing");
  assert.equal(without.text, freshWithout.text.split(freshWithout.world).join(without.world));
});

test("the key changes with every input a render is made from, and only with them", () => {
  const base = { args: ["--mcp-transport", "http"], registry: JSON.stringify(REGISTRY), bridge: { "a.mjs": "1" }, wrapper: { "bin/r.sh": "1" } };
  const key = renderKey("claude", base);
  assert.equal(renderKey("claude", { ...base }), key);
  for (const [what, client, inputs] of [
    ["the client", "codex", base],
    ["the installer's arguments", "claude", { ...base, args: ["--mcp-transport", "stdio"] }],
    ["the registry", "claude", { ...base, registry: JSON.stringify({ version: 1, services: {} }) }],
    ["no registry", "claude", { ...base, registry: "" }],
    ["a bridge file's bytes", "claude", { ...base, bridge: { "a.mjs": "2" } }],
    ["a bridge file's name", "claude", { ...base, bridge: { "b.mjs": "1" } }],
    ["a wrapper file's bytes", "claude", { ...base, wrapper: { "bin/r.sh": "2" } }],
    ["a wrapper file left out", "claude", { ...base, wrapper: {} }],
  ]) assert.notEqual(renderKey(client, inputs), key, `${what} did not change the key`);
  assert.notEqual(renderKey("claude", base, "another checkout"), key, "the installer, templates, bin and lib did not change the key");
});
