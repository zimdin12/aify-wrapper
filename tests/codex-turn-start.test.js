import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CODEX_STATE_EVENTS, codexHookHash, codexHookTrustKey, codexProfileHookTrusted, codexStateCommand } from "../lib/codex-herdr-hooks.mjs";
import { sealedPath, withPath } from "./sealed-path.mjs";
import { KEY, answer, host, service } from "./turn-start-host.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const posix = (s) => s.split(path.sep).join("/");
const runner = posix(path.join(root, "bin", "aify-turn-start.mjs"));
const state = posix(path.join(root, "bin", "aify-herdr-state.sh"));
const stateCommand = `sh "${state}" working`;
const rule = "fixture turn-start context";
const trustRow = (key, hash) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${hash}"\n`;

async function launch(t, endpoint, { target = true, herdr = false, subagent = false, resume = false,
  managed = resume, viaWrapper = resume, trustContext = false, trustState = resume, profile = null, trustProfile = false } = {}) {
  const env = host(t, { endpoint });
  const home = env.HOME;
  const registry = env.AIFY_SERVICE_REGISTRY;
  if (!target) fs.writeFileSync(registry, JSON.stringify({ version: 1, services: {} }));
  const { PATH, stubs } = sealedPath(["codex", "herdr"]);
  const stub = posix(fileURLToPath(new URL("./codex-turn-start-stub.mjs", import.meta.url)));
  fs.writeFileSync(path.join(stubs, "codex"), `#!/bin/bash\nexec node "${stub}" "$@"\n`, { mode: 0o755 });
  const out = path.join(home, "bin");
  const codex = path.join(home, "codex");
  const capture = path.join(home, "capture");
  Object.assign(env, { CODEX_HOME: codex, APPDATA: home, LOCALAPPDATA: home, AIFY_TEST_CODEX_CAPTURE: capture,
    AIFY_TEST_CODEX_SUBAGENT: subagent ? "1" : "0", HARNESS_IDENTITY: "probe-agent" });
  if (herdr) {
    env.AIFY_HERDR_PANE_FILE = path.join(home, "pane");
    env.HERDR_BIN_PATH = path.join(stubs, "herdr");
  }
  if (viaWrapper) env.AIFY_MANAGED_VIA_WRAPPER = "1";
  const trust = path.join(codex, "config.toml");
  fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codex, "sessions", "thread-1.jsonl"), "");
  let config = herdr && trustState ? CODEX_STATE_EVENTS.map(([, event, value]) =>
    trustRow(codexHookTrustKey(event, { root: path.parse(home).root }), codexHookHash(event, codexStateCommand(state, value)))).join("\n") : "";
  if (trustContext) {
    const event = "user_prompt_submit";
    const key = codexHookTrustKey(event, { root: path.parse(home).root, handlerIndex: herdr ? 1 : 0 });
    config += `\n${trustRow(key, codexHookHash(event, `node "${runner}"`, false))}`;
  }
  const bridge = path.join(home, "comms bridge", "mcp", "stdio");
  const hooksFile = path.join(codex, "hooks.json");
  let hooksJson;
  if (profile) {
    const installed = path.join(bridge, "node_modules", "aify-wrapper");
    if (profile === "installed") {
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.symlinkSync(root, installed, "dir");
    }
    const cmd = 'if [ -n "${AIFY_AGENT_ID:-}" ]; then node "' + posix(path.join(installed, "bin", "aify-turn-start.mjs")) + '"; fi';
    const group = { hooks: [{ type: "command", command: cmd, timeout: 5 }] };
    const unrelated = { hooks: [{ type: "command", command: "true", timeout: 2 }] };
    hooksJson = JSON.stringify({ hooks: { UserPromptSubmit: profile === "unrelated" ? [unrelated] : [unrelated, group] } });
    fs.writeFileSync(hooksFile, hooksJson);
    // Keyed as Codex keys a hooks.json hook (file, event, group, hook), in the quoting the Comms installer writes.
    if (trustProfile) config += `\n[hooks.state.'${hooksFile}:user_prompt_submit:1:0']\ntrusted_hash = "${codexHookHash("user_prompt_submit", cmd, false, 5)}"\n`;
    // Codex's agent loop skips a profile hook config.toml does not trust; only a managed launch has nobody to trust it.
    env.AIFY_TEST_CODEX_PROFILE_UNTRUSTED = managed && !trustProfile ? "1" : "0";
  }
  fs.writeFileSync(trust, config);
  const sealed = withPath(env, PATH);
  const rendered = spawnSync("bash", [path.join(root, "install.sh"), "--client", "codex", "--endpoint", "http://127.0.0.2:1",
    "--render-only", out, "--registry", registry, ...(profile ? ["--bridge-dir", bridge] : [])], { cwd: home, env: sealed, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr || rendered.error?.message);
  const flags = ["--safe", managed ? "--managed" : "--resident", ...(resume ? ["--resume", "thread-1"] : [])];
  const result = await run("bash", [path.join(out, "codex-aify"), ...flags], { cwd: home, env: sealed, encoding: "utf8", timeout: 60_000 }).catch((error) => {
    const log = path.join(home, ".aify", "sessions", "probe-agent", "codex-app-server.log");
    throw new Error(`${error.message}\nApp-server log: ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "not written"}`);
  });
  assert.equal(fs.readFileSync(trust, "utf8"), config, "launch must not write user trust configuration");
  if (hooksJson !== undefined) assert.equal(fs.readFileSync(hooksFile, "utf8"), hooksJson, "launch must not rewrite profile hooks");
  const appArgs = JSON.parse(fs.readFileSync(`${capture}.argv`, "utf8"));
  assert.equal(appArgs.includes("--dangerously-bypass-hook-trust"), false, "the app-server's existing trust policy must not be widened");
  return { ...result, ...JSON.parse(fs.readFileSync(`${capture}.turn`, "utf8")), appArgs,
    tuiArgs: JSON.parse(fs.readFileSync(`${capture}.tui`, "utf8")) };
}

const hook = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: rule } };
const stateHandler = { command: stateCommand, async: true, timeout: 3 };

test("the rendered app-server gets turn-start context beside the existing Herdr handler", async (t) => {
  const receiver = await service(t, answer(rule));
  const result = await launch(t, receiver.endpoint, { herdr: true });
  assert.deepEqual(result.handlers, [stateHandler, { command: `node "${runner}"`, async: false, timeout: 3 }], "one effective prompt list contains both handlers");
  assert.deepEqual(result.added, hook, "the stub app-server must receive exact additionalContext from the runner");
  assert.deepEqual(result.input, ["fixture prompt", rule]);
  assert.equal(receiver.seen.length, 1);
  assert.equal(receiver.seen[0].headers["x-api-key"], KEY);
  assert.equal(receiver.seen[0].body.sessionKey, "thread-1");
});

test("an upgraded Comms profile supplies context once, without shifting the Herdr hook", { skip: process.platform === "win32" }, async (t) => {
  const receiver = await service(t, answer(rule));
  const result = await launch(t, receiver.endpoint, { herdr: true, profile: "installed" });
  assert.equal(receiver.seen.length, 1, "the installed profile and the wrapper must not both submit turn-start");
  assert.deepEqual(result.handlers, [stateHandler], "the wrapper still supplies its async state hook");
  assert.deepEqual(result.input, ["fixture prompt", rule]);
});

test("an unrelated profile hook or a missing Comms runner does not displace turn-start", { skip: process.platform === "win32" }, async (t) => {
  const receiver = await service(t, answer(rule));
  for (const profile of ["unrelated", "missing-runner"]) {
    const result = await launch(t, receiver.endpoint, { profile });
    assert.deepEqual(result.handlers, [{ command: `node "${runner}"`, async: false, timeout: 3 }]);
    assert.deepEqual(result.input, ["fixture prompt", rule]);
  }
  assert.equal(receiver.seen.length, 2);
});

test("a managed resume leaves context to the profile hook only once Codex trusts it", { skip: process.platform === "win32" }, async (t) => {
  const receiver = await service(t, answer(rule));
  const resume = { resume: true, herdr: true, profile: "installed" };
  const neither = await launch(t, receiver.endpoint, resume);
  assert.deepEqual(neither.handlers, [stateHandler]);
  assert.match(neither.stderr, /turn-start context withheld: the hook is not trusted for this managed launch\./, "no hook can carry the context, and the launch must say so");
  assert.deepEqual(receiver.seen, []);
  const ours = await launch(t, receiver.endpoint, { ...resume, trustContext: true });
  assert.deepEqual(ours.handlers, [stateHandler, { command: `node "${runner}"`, async: false, timeout: 3 }],
    "Codex skips the untrusted profile hook, so the trusted launch hook must still carry the context");
  assert.equal(receiver.seen.length, 1);
  const theirs = await launch(t, receiver.endpoint, { ...resume, trustContext: true, trustProfile: true });
  assert.deepEqual(theirs.handlers, [stateHandler], "a trusted profile hook carries the context alone");
  assert.doesNotMatch(theirs.stderr, /turn-start context withheld/);
  assert.deepEqual(theirs.input, ["fixture prompt", rule]);
  assert.equal(receiver.seen.length, 2);
});

test("the profile hook's trust is read at the key and hash codex-cli 0.169.0 reported for it", () => {
  const hook = { command: 'if [ -n "${AIFY_AGENT_ID:-}" ]; then node "/opt/fake-bridge/node_modules/aify-wrapper/bin/aify-turn-start.mjs"; fi', timeout: 5 };
  const file = "/home/someone/.codex/hooks.json";
  const row = `[hooks.state.'${file}:user_prompt_submit:0:0']\ntrusted_hash = "sha256:28759988dcbbc4f705616ebdbae87587337da16194eaed3d15a9bbf6654b3fce"\n`;
  assert.equal(codexProfileHookTrusted(row, file, 0, hook), true);
  assert.equal(codexProfileHookTrusted(row, file, 1, hook), false, "trust recorded for one group is not another group's");
  assert.equal(codexProfileHookTrusted(row, file, 0, { ...hook, timeout: 3 }), false, "a changed hook is a hook Codex has not trusted");
});

test("no target adds no command; a subagent with a configured hook makes no request", async (t) => {
  const receiver = await service(t, answer(rule));
  const absent = await launch(t, receiver.endpoint, { target: false });
  assert.deepEqual(absent.handlers, [], "no registry target means no turn-start command");
  assert.deepEqual(absent.input, ["fixture prompt"]);
  const child = await launch(t, receiver.endpoint, { subagent: true });
  assert.equal(child.handlers.length, 1, "the subagent ran through the registered hook path");
  assert.equal(child.added, null);
  assert.deepEqual(child.input, ["fixture prompt"]);
  assert.deepEqual(receiver.seen, [], "no calls from a no-target or subagent turn");
});

test("managed resume withholds only the untrusted context handler and says so", async (t) => {
  const receiver = await service(t, answer(rule));
  const before = await launch(t, receiver.endpoint, { resume: true, herdr: true });
  assert.deepEqual(before.handlers, [stateHandler], "an untrusted context handler must not be sent to the managed app-server");
  assert.match(before.stderr, /turn-start context withheld: the hook is not trusted for this managed launch\./);
  assert.equal(before.added, null);
  assert.deepEqual(receiver.seen, []);
  const admitted = await launch(t, receiver.endpoint, { resume: true, herdr: true, trustContext: true });
  assert.deepEqual(admitted.handlers[0], stateHandler, "the async handler remains first and keeps its trust key");
  assert.deepEqual(admitted.added, hook, "the new handler is admitted only by its exact trust record");
  assert.doesNotMatch(admitted.stderr, /turn-start context withheld/);
  assert.equal(receiver.seen.length, 1);
});

test("a managed fresh start without the existing bypass requires trust for context", async (t) => {
  const receiver = await service(t, answer(rule));
  const local = await launch(t, receiver.endpoint, { managed: true });
  assert.equal(local.tuiArgs.includes("--dangerously-bypass-hook-trust"), false);
  assert.deepEqual(local.handlers, [], "a managed fresh launch without the bypass must withhold an untrusted hook");
  assert.match(local.stderr, /turn-start context withheld/);
  assert.deepEqual(receiver.seen, []);

  const trusted = await launch(t, receiver.endpoint, { managed: true, trustContext: true });
  assert.deepEqual(trusted.added, hook, "a trusted local managed fresh start gets context");
  const wrapped = await launch(t, receiver.endpoint, { managed: true, viaWrapper: true });
  assert.equal(wrapped.tuiArgs.includes("--dangerously-bypass-hook-trust"), true, "wrapped fresh start keeps its existing TUI bypass");
  assert.deepEqual(wrapped.added, hook);
  assert.equal(receiver.seen.length, 2);
});

test("local managed fresh starts withhold untrusted Herdr hooks and say so", async (t) => {
  const receiver = await service(t, answer(rule));
  const fresh = { target: false, managed: true, herdr: true };
  const local = await launch(t, receiver.endpoint, fresh);
  assert.ok(!local.appArgs.some((arg) => arg.startsWith("hooks.")), "local managed fresh must withhold all untrusted Herdr hooks");
  assert.match(local.stderr, /Herdr state hooks withheld: Codex does not trust them for this managed launch\./);
  assert.ok(!local.tuiArgs.includes("--dangerously-bypass-hook-trust"));

  const trusted = await launch(t, receiver.endpoint, { ...fresh, trustState: true });
  assert.deepEqual(trusted.handlers, [stateHandler], "admitted Herdr hooks still reach a local fresh start");
  assert.doesNotMatch(trusted.stderr, /Herdr state hooks withheld/);
  const wrapped = await launch(t, receiver.endpoint, { ...fresh, viaWrapper: true });
  assert.ok(wrapped.tuiArgs.includes("--dangerously-bypass-hook-trust"));
  assert.deepEqual(wrapped.handlers, [stateHandler], "the existing wrapped fresh bypass keeps the state hook");
  assert.doesNotMatch(wrapped.stderr, /Herdr state hooks withheld/);
  assert.deepEqual(receiver.seen, []);
});
