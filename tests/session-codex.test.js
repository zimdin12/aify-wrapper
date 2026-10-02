#!/usr/bin/env node
// Codex's half of per-session MCP: the opted-in servers as `-c` words for `codex app-server`.
//
// WHY THE APP-SERVER. It owns the session; the TUI only attaches with --remote. Measured on codex 0.159.3,
// 2026-10-01: `-c mcp_servers.<name>.command/args` on `app-server` loads the server beside the operator's own.
//
// WHY env_vars. The same run showed codex passes an MCP server no variable it is not told to: without
// `env_vars` the server saw AIFY_AGENT_ID as null. So every opted-in server forwards AIFY_AGENT_ID, plus the
// entry's own endpointEnv names. (aify-dashboard docs/evidence/codex-session-mcp-2026-10-01.)
//
// WHY NUL-TERMINATED WORDS IN BASE64. The launcher appends them to an array with
//   while IFS= read -r -d '' w; do CODEX_APP_SERVER_CONFIG+=("$w"); done < <(printf '%s' "$B64" | base64 -d)
// so a quote, `$(` or space in a registry value stays inside one word and is never parsed as shell. Each word
// is TERMINATED, not separated: `read -d ''` drops a last word that has no NUL after it.
//
// Expected values below are typed out by hand, never computed by the code under test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRegistry } from "../lib/registry.mjs";
import { sessionCodexWords, sessionCodexWordsBase64, tomlString } from "../lib/session-codex.mjs";

const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "lib", "registry-cli.mjs");
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92);

const DASHBOARD = {
  endpoint: "http://127.0.0.2:9700",
  credentialRef: "aify-dashboard.key",
  sessionInject: { mcp: true },
  mcp: [{ name: "aify-dashboard", command: "node", args: ["--experimental-strip-types", "/d/bridge/main.ts", "serve"] }],
};
const COMMS = { endpoint: "http://127.0.0.2:1", mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }] };
const registryWith = (services) => ({ version: 1, services: { "aify-comms": COMMS, ...services } });
const parsed = (services) => {
  const result = parseRegistry(JSON.stringify(registryWith(services)));
  assert.equal(result.ok, true, result.errors.join("; "));
  return result.registry;
};

function cli(services) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-codex-cli-"));
  const file = path.join(dir, "services.json");
  if (services !== undefined) fs.writeFileSync(file, JSON.stringify(registryWith(services)));
  const run = spawnSync(process.execPath, [CLI, "session-codex-b64", file], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return run;
}

test("an opted-in server becomes three -c pairs that forward the agent id", () => {
  const result = sessionCodexWords(parsed({ "aify-dashboard": DASHBOARD }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.words, [
    "-c", 'mcp_servers.aify-dashboard.command="node"',
    "-c", 'mcp_servers.aify-dashboard.args=["--experimental-strip-types", "/d/bridge/main.ts", "serve"]',
    "-c", 'mcp_servers.aify-dashboard.env_vars=["AIFY_AGENT_ID"]',
  ]);
});

test("the entry's endpointEnv names are forwarded after the agent id, and nothing else is", () => {
  const result = sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } }));
  assert.equal(result.words[5], 'mcp_servers.aify-dashboard.env_vars=["AIFY_AGENT_ID", "AIFY_DASHBOARD_URL"]');
});

test("a TOML string carries quotes, backslashes, $( and control bytes as escapes, never raw", () => {
  // The bug this catches: a value that closes the TOML string early, or a raw control byte codex refuses.
  assert.equal(tomlString(`a "b" $(x) c${BS}d`), `"a ${BS}"b${BS}" $(x) c${BS}${BS}d"`);
  assert.equal(tomlString(`tab${String.fromCharCode(9)}nul${NUL}`), `"tab${BS}u0009nul${BS}u0000"`);
});

test("every word is NUL-terminated, so the launcher's read loop keeps the last one", () => {
  // Measured with the exact decode line the launcher uses: a last word with no NUL after it is dropped.
  const words = sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "aify-dashboard", command: "node", args: [`a "b" $(x) c`] }] } })).words;
  const b64 = sessionCodexWordsBase64(parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "aify-dashboard", command: "node", args: [`a "b" $(x) c`] }] } })).value;
  const script = `A=(); while IFS= read -r -d '' w; do A+=("$w"); done < <(printf '%s' "${b64}" | base64 -d); printf '%s\\n' "\${#A[@]}"; printf '%s\\n' "\${A[@]}"`;
  const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [count, ...decoded] = run.stdout.split("\n").filter((l) => l !== "");
  assert.equal(Number(count), 6, `the loop kept ${count} of 6 words`);
  assert.deepEqual(decoded, words, "a word was split, joined or re-parsed by the shell");
  assert.equal(decoded[3], 'mcp_servers.aify-dashboard.args=["a \\"b\\" $(x) c"]');
});

test("a server name or variable name that is not plain is refused, with the name in the reason", () => {
  // A dot in a server name would become a nested TOML key; a dash in a variable name is no variable at all.
  const dotted = sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "a.b", command: "node" }] } }));
  assert.equal(dotted.ok, false);
  assert.match(dotted.problems.join("\n"), /"a\.b"/);
  const dashed = sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["NOT-A-NAME"] } }));
  assert.equal(dashed.ok, false);
  assert.match(dashed.problems.join("\n"), /"NOT-A-NAME"/);
  // The control: the same entry with plain names is accepted.
  assert.equal(sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } })).ok, true);
});

test("session-codex-b64: empty for no opt-in or no file, the words for one, 78 for a refusal", () => {
  // The contract aify-comms' installer calls (its owner, 2026-10-01).
  assert.deepEqual([cli({}).status, cli({}).stdout], [0, ""]);
  assert.deepEqual([cli(undefined).status, cli(undefined).stdout], [0, ""], "an absent registry is the empty registry");
  const one = cli({ "aify-dashboard": DASHBOARD });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, sessionCodexWordsBase64(parsed({ "aify-dashboard": DASHBOARD })).value);
  assert.ok(!one.stdout.endsWith("\n"), "a trailing newline would reach the launcher");
  const bad = cli({ "aify-dashboard": { ...DASHBOARD, endpointEnv: ["NOT-A-NAME"] } });
  assert.equal(bad.status, 78);
  assert.match(bad.stderr, /NOT-A-NAME/);
  // A key beside the opt-in never reaches the words: the registry itself is refused, so the verb exits 78.
  const keyed = cli({ "aify-dashboard": { ...DASHBOARD, keyEnv: ["AIFY_DASHBOARD_API_KEY"] } });
  assert.equal(keyed.status, 78);
  assert.equal(keyed.stdout, "");
});

test("a forwarded name that ANY service declares as a key is refused, so no credential variable reaches the server", () => {
  // ⛔ The bug this catches (the senior reviewer's C1, 2026-10-01): the parse refusal is per service, so an opted-in
  // entry with no keyEnv of its own could list, in endpointEnv, the variable ANOTHER service keeps its key in. codex
  // forwards a variable's inherited VALUE, so the server would be handed that credential.
  const keyed = { ...COMMS, keyEnv: ["SYNTHETIC_CREDENTIAL_VAR"] };
  const result = sessionCodexWords(parsed({ "aify-comms": keyed, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["SYNTHETIC_CREDENTIAL_VAR"] } }));
  assert.equal(result.ok, false, "a key variable was forwarded");
  assert.match(result.problems.join("\n"), /"SYNTHETIC_CREDENTIAL_VAR".*aify-comms/);
  // And the identity variable is no exception: forwarded to every server, so refused if any service keeps a key in it.
  const agentAsKey = sessionCodexWords(parsed({ "aify-comms": { ...COMMS, keyEnv: ["AIFY_AGENT_ID"] }, "aify-dashboard": DASHBOARD }));
  assert.equal(agentAsKey.ok, false);
  // The control: a distinct name beside the same keyed neighbour is accepted.
  assert.equal(sessionCodexWords(parsed({ "aify-comms": keyed, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } })).ok, true);
});

test("a command or argument UTF-8 cannot carry is refused, never silently replaced", () => {
  // ⛔ The bug this catches (the senior reviewer's C2, 2026-10-01): a lone surrogate parses as JSON and becomes U+FFFD
  // on the way to UTF-8, so codex would be given a different path than the registry holds, with exit 0.
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  const loneArg = sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "aify-dashboard", command: "node", args: [`prefix${high}suffix`] }] } }));
  assert.equal(loneArg.ok, false, "a lone high surrogate in an argument was accepted");
  const loneCommand = sessionCodexWords(parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "aify-dashboard", command: `prefix${low}suffix`, args: [] }] } }));
  assert.equal(loneCommand.ok, false, "a lone low surrogate in the command was accepted");
  assert.match(`${loneArg.problems} ${loneCommand.problems}`, /UTF-8/);
  // The control: a correctly paired surrogate is ordinary text and round-trips through base64 unchanged.
  const emoji = String.fromCodePoint(0x1f600);
  const paired = sessionCodexWordsBase64(parsed({ "aify-dashboard": { ...DASHBOARD, mcp: [{ name: "aify-dashboard", command: "node", args: [`a${emoji}b`] }] } }));
  assert.equal(paired.ok, true);
  assert.ok(Buffer.from(paired.value, "base64").toString("utf8").includes(`a${emoji}b`), "a paired surrogate did not survive");
});

test("a neighbour's key variable spelled in another case is refused too, because Windows names are one variable", () => {
  // ⛔ The bug this catches (the senior reviewer's C3, 2026-10-01): the whole-registry join compared exact strings, but
  // a native Windows environment folds case, so `synthetic_credential_var` and `SYNTHETIC_CREDENTIAL_VAR` are ONE
  // variable there. Refused case-folded on every platform; the names keep their own spelling in the reason.
  const endpointAlias = cli({ "aify-comms": { ...COMMS, keyEnv: ["synthetic_credential_var"] }, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["SYNTHETIC_CREDENTIAL_VAR"] } });
  assert.deepEqual([endpointAlias.status, endpointAlias.stdout], [78, ""], "an endpoint variable aliasing a key was forwarded");
  assert.match(endpointAlias.stderr, /"SYNTHETIC_CREDENTIAL_VAR".*aify-comms/);
  const identityAlias = cli({ "aify-comms": { ...COMMS, keyEnv: ["aify_agent_id"] }, "aify-dashboard": DASHBOARD });
  assert.deepEqual([identityAlias.status, identityAlias.stdout], [78, ""], "the agent id was forwarded while a neighbour keeps a key in its alias");
  assert.match(identityAlias.stderr, /"AIFY_AGENT_ID".*aify-comms/);
  // The control: a distinct name beside the same lower-case holder is accepted.
  const distinct = cli({ "aify-comms": { ...COMMS, keyEnv: ["synthetic_credential_var"] }, "aify-dashboard": { ...DASHBOARD, endpointEnv: ["AIFY_DASHBOARD_URL"] } });
  assert.equal(distinct.status, 0, distinct.stderr);
  assert.notEqual(distinct.stdout, "");
});
