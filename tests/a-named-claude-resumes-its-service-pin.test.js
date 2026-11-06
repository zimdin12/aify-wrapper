// Wrapper-half contract tests: the service-owned helper is deliberately a stub, NOT service/API qualification.
// Unlike argv-only producer tests, these inspect the actual native runtime reached by a rendered launcher.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { KNOWN, UNKNOWN, NOWHERE, launch } from "./launch-to-a-stub-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MISSING = "88888888-7777-6666-5555-444444444444";
const HELPER = `import fs from 'node:fs';
const [endpoint,runtime,agent]=process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'pin',endpoint,runtime,agent})+'\\n');
process.stdout.write(process.env.STUB_PIN_REPLY ?? 'found\\t${KNOWN}\\n');
process.exit(Number(process.env.STUB_PIN_EXIT || 0));\n`;
const REAPER = `import fs from 'node:fs';fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'reap',args:process.argv.slice(2)})+'\\n');\n`;
function run(args = [], { env = {}, files = {}, helper = true, bridge = {}, agentId = "test-agent" } = {}) {
  return launch("claude", ["--aify-agent", agentId, ...args], {
    cwd: "work", env, files,
    bridgeFiles: { ...(helper ? { "session-for-agent.mjs": HELPER } : {}), "reap-managed-claude.js": REAPER, ...bridge },
  });
}
function nativeResume(result) { const index = result.args.indexOf("--resume"); return index < 0 ? "" : result.args[index + 1]; }
function useful(result, expected = 0) { assert.equal(result.run.status, expected, result.run.stderr); assert.equal(result.started.AIFY_AGENT_ID, "test-agent"); }
function fresh(result) { useful(result); assert.equal(nativeResume(result), ""); assert.equal(result.started.CLAUDE_SESSION_ID || "", ""); }

for (const args of [[], ["--managed"], ["--resident"]]) test(`an ordinary explicitly named ${args[0] || "non-TTY"} launch resumes the pin in native argv`, () => {
  const result = run(args); useful(result);
  assert.equal(nativeResume(result), KNOWN); assert.equal(result.started.CLAUDE_SESSION_ID, KNOWN);
  assert.deepEqual(result.asked, [{ kind: "pin", endpoint: NOWHERE, runtime: "claude-code", agent: "test-agent" }], "lookup must not authorize reap without a won claim");
  assert.match(result.run.stderr, /resum.*pinned|pinned.*resum/i);
});

test("an implicit resume follows today's configured model, not the transcript's historical model", () => {
  const result = run([], { files: { "<home>/.claude/settings.json": '{"model":"profile-current"}' } }); useful(result);
  assert.equal(nativeResume(result), KNOWN); assert.equal(result.args[result.args.indexOf("--model") + 1], "profile-current");
});

for (const marker of [false, true]) test(`matched managed empty conversation stays fresh${marker ? " after inherited-session scrubbing" : ""}, without a new caller flag`, () => {
  // Hygiene's named-agent input comes from the real shell intent parser, not a fixture-invented marker.
  const files = marker ? Object.fromEntries(["aify-lease.sh", "aify-inherited-session.sh"].map(name => [`wrapper/bin/${name}`, fs.readFileSync(path.join(ROOT, "bin", name), "utf8")])) : {};
  const result = run([], { files, env: { AIFY_AGENT_ID: "test-agent", AIFY_SESSION_MODE: "managed", AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_SESSION_HANDLE: "", CLAUDE_SESSION_ID: "", ...(marker ? { CLAUDE_CODE_CHILD_SESSION: "1" } : {}) } });
  fresh(result); assert.deepEqual(result.asked, [], "reset/handoff managed intent consulted an old pin");
});

test("a mode flag does not overwrite the incoming managed conversation intent", () => {
  const result = run(["--resident"], { env: { AIFY_AGENT_ID: "test-agent", AIFY_SESSION_MODE: "managed", AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_SESSION_HANDLE: "" } });
  fresh(result); assert.deepEqual(result.asked, []);
});

for (const args of [["--resume", KNOWN], ["-r", KNOWN], [`--resume=${KNOWN}`], ["--session-id", KNOWN], ["--continue"], ["-c"], ["--fork-session"], [`-r${KNOWN}`], ["-cprevious"]]) test(`${args[0]} vetoes implicit pin lookup`, () => {
  const result = run(args); useful(result); assert.equal(result.asked.some(row => row.kind === "pin"), false);
});

test("an invalid explicit handle's fresh fallback is never replaced with a service pin", () => {
  const result = run(["--resume", MISSING]); fresh(result); assert.deepEqual(result.asked, []);
});

test("--new-session clears ambient conversation and never reaches native argv", () => {
  const result = run(["--new-session"], { env: { CLAUDE_SESSION_ID: KNOWN } }); fresh(result);
  assert.deepEqual(result.asked, []); assert.equal(result.args.includes("--new-session"), false);
});

for (const args of [["--new-session", "--resume", KNOWN], ["--resume", "--new-session"], ["-r", "--new-session"], ["--session-id", "--new-session"]]) test(`fresh/native conflict ${args.join(" ")} refuses before lookup or runtime`, () => {
  const result = run(args);
  assert.equal(result.run.status, 78, result.run.stderr); assert.deepEqual(result.started, {}); assert.deepEqual(result.asked, []);
});

for (const reply of ["none\n", "wrong-runtime\n", "unavailable\n", `found\t${MISSING}\n`, "found\tnot-a-uuid\n", "found\t../../elsewhere\n", "garbage\n"]) test(`unusable pin ${JSON.stringify(reply)} visibly preserves useful fresh launch`, () => {
  const result = run([], { env: { STUB_PIN_REPLY: reply } }); fresh(result);
  assert.equal(result.asked.filter(row => row.kind === "pin").length, 1);
  assert.match(result.run.stderr, /fresh/i);
});

test("an older installed bridge with no helper visibly falls back fresh", () => {
  const result = run([], { helper: false }); fresh(result); assert.deepEqual(result.asked, []); assert.match(result.run.stderr, /fresh/i);
});

test("pin validation never borrows a transcript from another selected profile", () => {
  const result = run([], { env: { CLAUDE_CONFIG_DIR: ({ dir }) => path.join(dir, "selected-profile") }, files: { "selected-profile/settings.json": "{}" } });
  fresh(result); assert.match(result.run.stderr, /fresh/i);
});

test("a selected profile's own transcript and current model are used together", () => {
  const result = run([], { env: { CLAUDE_CONFIG_DIR: ({ dir }) => path.join(dir, "selected-profile") }, files: {
    [`selected-profile/projects/p/${KNOWN}.jsonl`]: "{}\n", "selected-profile/settings.json": '{"model":"selected-profile-model"}',
  } }); useful(result); assert.equal(nativeResume(result), KNOWN);
  assert.equal(result.args[result.args.indexOf("--model") + 1], "selected-profile-model");
});

function leaseFiles() {
  return Object.fromEntries(["bin/aify-lease.sh", "bin/aify-agent-lease.mjs", "lib/agent-lease.mjs", "lib/agent-lease-watch.mjs", "lib/file-lock.mjs", "lib/inherited-session.mjs"]
    .map(file => [`wrapper/${file}`, fs.readFileSync(path.join(ROOT, file), "utf8")]));
}
test("an actual won matching lease permits the scoped managed reap; useful pinned launch still reaches native", () => {
  const agentId = `lease-pin-${process.pid}-${randomUUID().slice(0, 8)}`;
  const result = run(["--managed"], { agentId, env: { AIFY_AGENT_LEASE_WATCH: "0" }, files: leaseFiles() });
  assert.equal(result.run.status, 0, result.run.stderr); assert.equal(result.started.AIFY_AGENT_ID, agentId);
  assert.equal(nativeResume(result), KNOWN); assert.ok(Number(result.started.AIFY_AGENT_LEASE) > 0);
  assert.deepEqual(result.asked.filter(row => row.kind === "reap"), [{ kind: "reap", args: [KNOWN, agentId] }]);
});
test("a failed-open claim cannot use an inherited lease PID to reap, while the explicit native resume remains useful", () => {
  const agentId = `failed-pin-${process.pid}-${randomUUID().slice(0, 8)}`;
  const result = run(["--managed", "--resume", KNOWN], { agentId, env: { AIFY_AGENT_LEASE: String(process.pid), AIFY_AGENT_LEASE_WATCH: "0" },
    files: { ...leaseFiles(), "wrapper/bin/aify-agent-lease.mjs": "process.exit(70);\n" } });
  assert.equal(result.run.status, 0, result.run.stderr); assert.equal(result.started.AIFY_AGENT_ID, agentId); assert.equal(nativeResume(result), KNOWN);
  assert.deepEqual(result.asked, [], "failed-open claim acted as holder merely because an inherited lease PID was present");
});

// These are parser/provenance integrations, not additional copies of the pure eligibility truth table.
for (const alias of [["--agent-id", "test-agent"], ["--agent-id=test-agent"]]) test(`the final explicit alias ${alias[0]} selects its own pin`, () => {
  const result = run(alias, { agentId: "earlier-agent" }); useful(result); assert.equal(nativeResume(result), KNOWN);
  assert.equal(result.asked[0].agent, "test-agent");
});
for (const supplied of [{ CLAUDE_SESSION_ID: KNOWN }, { AIFY_SESSION_HANDLE: KNOWN }]) test(`surviving ${Object.keys(supplied)[0]} is not replaced by a different pin`, () => {
  const result = run([], { env: { ...supplied, STUB_PIN_REPLY: `found\t${UNKNOWN}\n` } }); useful(result);
  assert.deepEqual(result.asked, []); assert.equal(nativeResume(result), "");
  assert.equal(result.started[Object.keys(supplied)[0]], KNOWN);
});
test("an ambient agent name alone never opts into the new explicit-name default", () => {
  const result = launch("claude", [], { cwd: "work", env: { AIFY_AGENT_ID: "test-agent" }, bridgeFiles: { "session-for-agent.mjs": HELPER } });
  useful(result); assert.deepEqual(result.asked, []); assert.equal(nativeResume(result), "");
});
test("a failed helper cannot select its valid-looking stdout", () => {
  const result = run([], { env: { STUB_PIN_EXIT: "70" } }); fresh(result); assert.match(result.run.stderr, /fresh/i);
});

// The fixture refuses endpoint/instance leakage and daemon descriptors at entry AND in the host child.
const SHARED_GUARD = `import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
const forbidden=Object.keys(process.env).filter(key=>key.toUpperCase().startsWith('AIFY_ENV_') && /ENDPOINT|URL|INSTANCE/.test(key.toUpperCase()));
if (forbidden.length) { console.error('SHARED_SEAL_ENV: '+forbidden.join(','));process.exit(78); }
const home=path.join(path.dirname(fileURLToPath(import.meta.url)),'home');
if (path.resolve(os.homedir())!==path.resolve(home)) { console.error('SHARED_SEAL_HOME');process.exit(78); }
if (fs.existsSync(path.join(home,'.aify','env'))) { console.error('SHARED_SEAL_DESCRIPTOR');process.exit(78); }
`;
function sharedRun({ env = {}, files = {} } = {}) {
  return run(["--shared", "--new-session"], { env: { BASH_ENV: ({ dir }) => path.join(dir, "load-host.sh"), ...env }, files: {
    "load-host.sh.guard.mjs": SHARED_GUARD,
    "load-host.sh": 'node "$BASH_ENV.guard.mjs" || exit 78\n_host_bin="$BASH_ENV.host-bin"\nif command -v cygpath >/dev/null 2>&1; then _host_bin="$(cygpath -u "$_host_bin")" || exit 78; fi\n[ -f "$_host_bin/aify-env" ] && chmod +x "$_host_bin/aify-env" || exit 78\nexport PATH="$_host_bin:$PATH"\n[ "$(command -v aify-env)" = "$_host_bin/aify-env" ] || exit 78\n',
    "load-host.sh.host-bin/aify-env": '#!/bin/bash\nexec node "$BASH_ENV.host.mjs" "$@"\n',
    "load-host.sh.host.mjs": "import './load-host.sh.guard.mjs';import fs from 'node:fs';fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'host',executable:process.argv[1],args:process.argv.slice(2)})+'\\n');\n",
    ...files,
  } });
}
for (const key of ["AIFY_ENV_ENDPOINT", "AIFY_ENV_URL", "AIFY_ENV_INSTANCE", "AIFY_ENV_OTHER_ENDPOINT"]) test(`shared fixture refuses inherited ${key} before any dispatch`, () => {
  const result = sharedRun({ env: { [key]: key.includes("INSTANCE") ? "fixture-instance" : NOWHERE } });
  assert.equal(result.run.status, 78, "endpoint/instance seal must fail closed"); assert.match(result.run.stderr, /SHARED_SEAL_ENV/);
  assert.deepEqual(result.asked, []); assert.deepEqual(result.started, {});
});
test("shared fixture refuses a daemon descriptor in its otherwise owned home", () => {
  const result = sharedRun({ files: { "<home>/.aify/env/default.json": JSON.stringify({ endpoint: NOWHERE }) } });
  assert.equal(result.run.status, 78, "descriptor seal must fail closed"); assert.match(result.run.stderr, /SHARED_SEAL_DESCRIPTOR/);
  assert.deepEqual(result.asked, []); assert.deepEqual(result.started, {});
});
// Existing handoff tests prove dispatch; these prove the new escape survives both original-argv boundaries.
test("shared preliminary does no pin query and hands the fresh escape unchanged to its actual child", () => {
  const result = sharedRun();
  assert.equal(result.run.status, 0, result.run.stderr); assert.deepEqual(result.started, {});
  assert.equal(result.asked.length, 1); assert.equal(result.asked[0].kind, "host");
  const forwarded = result.asked[0].args.slice(result.asked[0].args.indexOf("--") + 1);
  assert.deepEqual(forwarded, ["--aify-agent", "test-agent", "--new-session"]);
  const child = launch("claude", forwarded, { cwd: "work", env: { CLAUDE_SESSION_ID: KNOWN }, bridgeFiles: { "session-for-agent.mjs": HELPER } });
  fresh(child); assert.deepEqual(child.asked, []); assert.equal(child.args.includes("--new-session"), false);
});
test("Herdr's real shell claim receives the original fresh escape before native filtering", () => {
  const result = run(["--new-session"], { env: { HERDR_ENV: "1", HERDR_PANE_ID: "fixture-pane" }, files: {
    "wrapper/bin/aify-herdr-pane.mjs": "import fs from 'node:fs';fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'pane',args:process.argv.slice(2)})+'\\n');process.stdout.write('claimed');\n",
  } });
  fresh(result); assert.equal(result.args.includes("--new-session"), false);
  assert.equal(result.asked.length, 1); assert.equal(result.asked[0].kind, "pane");
  const original = result.asked[0].args.slice(result.asked[0].args.indexOf("--") + 1);
  assert.deepEqual(original.slice(1), ["--aify-agent", "test-agent", "--new-session"]);
});

test("--check never consults the service pin or starts the runtime", () => {
  const result = run(["--check"]); assert.equal(result.run.status, 0, result.run.stderr); assert.deepEqual(result.asked, []); assert.deepEqual(result.started, {});
});
