#!/usr/bin/env node
// The turn-start runner (bin/aify-turn-start.mjs, lib/turn-start.mjs): what the registry's turnStart services say
// reaches the turn, and nothing they do can delay or break it.
//
// REAL SERVERS, not a fetch double: a stall, a body that never ends and a redirect behave here as they do on the wire.
// The end-to-end tests run the real hook command with a sealed home, registry and credential file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRegistry, TURN_START_DEADLINE_MS } from "../lib/registry.mjs";
import { hookOutput, runTurnStart, turnStartTargets } from "../lib/turn-start.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "bin", "aify-turn-start.mjs");
const KEY = "sekret-key-0123456789";

/** A local service: `behave(request, response, body)` decides the answer; every request is recorded. */
async function service(t, behave) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : null });
      behave(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, seen };
}

const answer = (text) => (request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ text, firedEventIds: [] }));
};
const never = () => {};

function registryOf(entries) {
  const parsed = parseRegistry(JSON.stringify({ version: 1, services: entries }));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  return parsed.registry;
}

const REQUEST = { agentId: "probe-agent", cwd: "C:/work/project", machineId: "win32:probe-host", sessionKey: "sess-1" };
/** An invocation that started now and is due in `ms`. */
const due = (ms) => { const startedAt = Date.now(); return { startedAt, dueAt: startedAt + ms }; };

// ---- the registry carries the capability ------------------------------------------------------------------------

test("THE PARSER carries turnStart with its budget, defaults the budget to the shared deadline, and refuses the rest", () => {
  const ok = registryOf({ dash: { endpoint: "http://127.0.0.1:1", turnStart: { path: "/events/turn-start", budgetMs: 800 } },
    plain: { endpoint: "http://127.0.0.1:2", turnStart: { path: "/t" } }, none: { endpoint: "http://127.0.0.1:3" } });
  assert.deepEqual(ok.services.dash.turnStart, { path: "/events/turn-start", budgetMs: 800 });
  assert.deepEqual(ok.services.plain.turnStart, { path: "/t", budgetMs: TURN_START_DEADLINE_MS });
  assert.equal(ok.services.none.turnStart, undefined);
  for (const turnStart of [{ path: "/t", extra: 1 }, { path: "//evil/t" }, { path: "http://x/t" }, { path: "/a b" },
    { path: "/t", budgetMs: 0 }, { path: "/t", budgetMs: TURN_START_DEADLINE_MS + 1 }, { path: "/t", budgetMs: 1.5 },
    { path: "/t", budgetMs: "800" }, "/t", null]) {
    const parsed = parseRegistry(JSON.stringify({ version: 1, services: { s: { endpoint: "http://127.0.0.1:1", turnStart } } }));
    assert.equal(parsed.ok, false, `accepted ${JSON.stringify(turnStart)}`);
    assert.match(parsed.errors.join(" "), /turnStart/);
  }
});

test("THE TARGETS are the declaring services, in the parser's order, each on its own endpoint", () => {
  const registry = registryOf({ zeta: { endpoint: "http://127.0.0.1:9/", turnStart: { path: "/z" } },
    alpha: { endpoint: "http://127.0.0.1:8/base", turnStart: { path: "/a", budgetMs: 5 }, credentialRef: "alpha.key" },
    quiet: { endpoint: "http://127.0.0.1:7" } });
  assert.deepEqual(turnStartTargets(registry), [
    { service: "alpha", url: "http://127.0.0.1:8/base/a", budgetMs: 5, credentialRef: "alpha.key" },
    { service: "zeta", url: "http://127.0.0.1:9/z", budgetMs: TURN_START_DEADLINE_MS, credentialRef: "" },
  ]);
});

// ---- the deadline, the peers and the key ------------------------------------------------------------------------

test("A STALLED PEER CANNOT DELAY OR DROP A FAST ONE: headers that never come, and a body that never ends", async (t) => {
  const fast = await service(t, answer("FAST RULE"));
  const stalled = await service(t, never);
  const endless = await service(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"text":"never fini');
  });
  const targets = [
    { service: "a-endless", url: `${endless.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
    { service: "b-fast", url: `${fast.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
    { service: "c-stalled", url: `${stalled.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
  ];
  const started = Date.now();
  const result = await runTurnStart({ targets, request: REQUEST, keyFor: () => KEY, fetchImpl: fetch, ...due(300) });
  const took = Date.now() - started;
  assert.equal(result.text, "FAST RULE");
  assert.deepEqual(result.outcomes.map((o) => [o.service, o.reason]), [["a-endless", "timeout"], ["b-fast", ""], ["c-stalled", "timeout"]]);
  assert.ok(took < 1000, `the shared deadline of 300 ms took ${took} ms`);
});

test("A SERVICE'S BUDGET ONLY SHORTENS ITS OWN WAIT", async (t) => {
  const slow = (text) => (request, response) => setTimeout(() => answer(text)(request, response), 250);
  const tight = await service(t, slow("TIGHT"));
  const roomy = await service(t, slow("ROOMY"));
  const result = await runTurnStart({ request: REQUEST, keyFor: () => KEY, fetchImpl: fetch, ...due(1500), targets: [
    { service: "roomy", url: `${roomy.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
    { service: "tight", url: `${tight.endpoint}/t`, budgetMs: 50, credentialRef: "k" },
  ] });
  assert.equal(result.text, "ROOMY");
  assert.deepEqual(result.outcomes.map((o) => o.reason), ["", "timeout"]);
});

test("A SERVICE'S BUDGET CUTS ITS BODY TOO: a body that never ends closes the answer at that budget, not the shared deadline", async (t) => {
  const endless = await service(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"text":"never fini');
  });
  const window = due(1500);
  const result = await runTurnStart({ request: REQUEST, keyFor: () => KEY, fetchImpl: fetch, ...window,
    targets: [{ service: "endless", url: `${endless.endpoint}/t`, budgetMs: 200, credentialRef: "k" }] });
  const closedAt = Date.now() - window.startedAt;
  assert.deepEqual(result.outcomes.map((o) => o.reason), ["timeout"]);
  assert.ok(closedAt < 900, `a 200 ms budget held the turn ${closedAt} ms`);
});

test("A FAILING, MALFORMED OR KEYLESS SERVICE CONTRIBUTES NOTHING; THE ANSWERS JOIN IN TARGET ORDER", async (t) => {
  const first = await service(t, answer("FIRST"));
  const second = await service(t, answer("SECOND"));
  const failing = await service(t, (request, response) => { response.writeHead(500); response.end("{\"text\":\"leak\"}"); });
  const html = await service(t, (request, response) => { response.writeHead(200); response.end("<html>"); });
  const shapeless = await service(t, (request, response) => { response.writeHead(200); response.end("{\"text\":5}"); });
  const keyless = await service(t, answer("UNREACHED"));
  const result = await runTurnStart({ request: REQUEST, fetchImpl: fetch, ...due(1500),
    keyFor: (ref) => (ref === "none" ? "" : KEY), targets: [
      { service: "1", url: `${first.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
      { service: "2", url: `${failing.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
      { service: "3", url: `${html.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
      { service: "4", url: `${shapeless.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
      { service: "5", url: `${keyless.endpoint}/t`, budgetMs: 1500, credentialRef: "none" },
      { service: "6", url: `${second.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
    ] });
  assert.equal(result.text, "FIRST\n\nSECOND");
  assert.deepEqual(result.outcomes.map((o) => o.reason), ["", "status-500", "not-json", "no-text", "no-key", ""]);
  assert.equal(keyless.seen.length, 0, "a service with no key was called anyway");
});

test("THE REQUEST: the agent, folder, machine and session in the body; the key and the agent in headers; no isFirstTurn", async (t) => {
  const svc = await service(t, answer("ok"));
  await runTurnStart({ request: REQUEST, keyFor: () => KEY, fetchImpl: fetch, ...due(1500),
    targets: [{ service: "s", url: `${svc.endpoint}/events/turn-start`, budgetMs: 1500, credentialRef: "k" }] });
  const [seen] = svc.seen;
  assert.equal(seen.url, "/events/turn-start");
  assert.equal(seen.headers["x-api-key"], KEY);
  assert.equal(seen.headers["x-aify-agent"], "probe-agent");
  assert.deepEqual(seen.body, REQUEST);
});

test("A REDIRECT IS REFUSED, so the key never reaches the address it names", async (t) => {
  const elsewhere = await service(t, answer("STOLEN"));
  const redirecting = await service(t, (request, response) => {
    response.writeHead(307, { location: `${elsewhere.endpoint}/t` });
    response.end();
  });
  const result = await runTurnStart({ request: REQUEST, keyFor: () => KEY, fetchImpl: fetch, ...due(1500),
    targets: [{ service: "r", url: `${redirecting.endpoint}/t`, budgetMs: 1500, credentialRef: "k" }] });
  assert.equal(result.text, "");
  assert.equal(result.outcomes[0].reason, "error");
  assert.equal(elsewhere.seen.length, 0, "the redirect was followed");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test("PREPARATION SPENDS THE SAME DEADLINE: a slow key read leaves less for its request, and a fast peer's text is kept", { timeout: 10000 }, async (t) => {
  const fast = await service(t, answer("FAST RULE"));
  const late = await service(t, (request, response) => setTimeout(() => answer("LATE")(request, response), 200));
  const hung = await service(t, answer("NEVER ASKED"));
  const after = await service(t, answer("TOO LATE TO ASK"));
  const keys = { fast: KEY, late: new Promise((resolve) => setTimeout(() => resolve(KEY), 400)), hung: new Promise(() => {}),
    after: new Promise((resolve) => setTimeout(() => resolve(KEY), 600)) };
  const window = due(500);
  const result = await runTurnStart({ request: REQUEST, fetchImpl: fetch, ...window, keyFor: (ref) => keys[ref], targets: [
    { service: "fast", url: `${fast.endpoint}/t`, budgetMs: 1500, credentialRef: "fast" },
    // Its key arrives at 400 ms, so 100 ms remain for a service that answers in 200: it is cut, not given a fresh budget.
    { service: "late", url: `${late.endpoint}/t`, budgetMs: 1500, credentialRef: "late" },
    // Its key never arrives: only the fence ends it, and the fence keeps what had already arrived.
    { service: "hung", url: `${hung.endpoint}/t`, budgetMs: 1500, credentialRef: "hung" },
    // Its key arrives after the due time: it is never sent a request, even once the key is in hand.
    { service: "after", url: `${after.endpoint}/t`, budgetMs: 1500, credentialRef: "after" },
  ] });
  const closedAt = Date.now() - window.startedAt;
  assert.equal(result.text, "FAST RULE");
  assert.deepEqual(result.outcomes.map((o) => [o.service, o.reason]), [["fast", ""], ["late", "timeout"], ["hung", "timeout"], ["after", "timeout"]]);
  assert.equal(hung.seen.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(after.seen.length, 0, "a request was admitted after the due time");
  assert.equal(late.seen.length, 1, "control: a key that arrived in time was used");
  assert.ok(closedAt >= 450 && closedAt < 900, `closed at ${closedAt} ms for a 500 ms due time`);
});

test("A TEXT THAT CARRIES A PRESENTED KEY IS REFUSED, and the healthy peer's text still arrives", async (t) => {
  const healthy = await service(t, answer("HEALTHY RULE"));
  const reflecting = await service(t, (request, response) => answer(`rule: ${request.headers["x-api-key"]}`)(request, response));
  const result = await runTurnStart({ request: REQUEST, keyFor: () => KEY, fetchImpl: fetch, ...due(1500), targets: [
    { service: "healthy", url: `${healthy.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
    { service: "reflecting", url: `${reflecting.endpoint}/t`, budgetMs: 1500, credentialRef: "k" },
  ] });
  assert.equal(result.text, "HEALTHY RULE");
  assert.deepEqual(result.outcomes.map((o) => o.reason), ["", "reflects-key"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test("THE OUTPUT is Claude's UserPromptSubmit shape, and nothing at all when nothing was said", () => {
  assert.deepEqual(JSON.parse(hookOutput("RULE")),
    { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "RULE" } });
  assert.equal(hookOutput(""), "");
});

// ---- the hook command, end to end ----------------------------------------------------------------------------------

/** A sealed host: a home with a credential, a registry naming `endpoint`, and the runner's environment. */
function host(t, { endpoint, credential = `${KEY}\n`, env = {}, more = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-turn-start-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".aify", "credentials"), { recursive: true });
  fs.writeFileSync(path.join(home, ".aify", "credentials", "dash.key"), credential);
  const registry = path.join(home, ".aify", "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { dash: {
    endpoint, credentialRef: "dash.key", turnStart: { path: "/events/turn-start", budgetMs: 800 } }, ...more } }));
  const sealed = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(AIFY_|HERDR_|CLAUDE_)/i.test(name) && !["COMPUTERNAME", "HOSTNAME"].includes(name.toUpperCase())) sealed[name] = value;
  }
  return { ...sealed, HOME: home, USERPROFILE: home, AIFY_SERVICE_REGISTRY: registry, AIFY_AGENT_ID: "probe-agent",
    COMPUTERNAME: "Probe-HOST", ...env };
}

/** Run the hook as Claude does; `stdin` null leaves the pipe open and never writes. */
function runHook(env, stdin) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [RUNNER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => { if (stdin === null) child.stdin.destroy(); resolve({ code, stdout, stderr, took: Date.now() - started }); });
    if (stdin !== null) child.stdin.end(stdin);
  });
}

const HOOK_INPUT = JSON.stringify({ session_id: "claude-session-42", cwd: "C:\\Docker\\aify-dashboard", hook_event_name: "UserPromptSubmit", prompt: "hi" });

test("END TO END: the hook sends the runner-built request and prints the context", async (t) => {
  const svc = await service(t, answer("OPERATOR RULE"));
  const result = await runHook(host(t, { endpoint: svc.endpoint }), HOOK_INPUT);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput, { hookEventName: "UserPromptSubmit", additionalContext: "OPERATOR RULE" });
  const [seen] = svc.seen;
  assert.equal(seen.headers["x-api-key"], KEY);
  assert.equal(seen.headers["x-aify-agent"], "probe-agent");
  // PLACEMENT: the id the runner itself derived, lower-cased, from a mixed-case COMPUTERNAME.
  const tag = process.platform === "linux" && /microsoft|wsl/i.test(fs.existsSync("/proc/sys/kernel/osrelease") ? fs.readFileSync("/proc/sys/kernel/osrelease", "utf8") : "") ? "wsl" : process.platform;
  assert.deepEqual(seen.body, { agentId: "probe-agent", cwd: "C:\\Docker\\aify-dashboard", machineId: `${tag}:probe-host`, sessionKey: "claude-session-42" });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));
});

test("END TO END, A SERVICE ECHOING ITS KEY ADDS NOTHING AND PRINTS NO KEY, and its healthy peer still arrives", async (t) => {
  const healthy = await service(t, answer("HEALTHY RULE"));
  const reflecting = await service(t, (request, response) => answer(`your key is ${request.headers["x-api-key"]}`)(request, response));
  const env = host(t, { endpoint: healthy.endpoint, more: { echo: { endpoint: reflecting.endpoint, credentialRef: "echo.key",
    turnStart: { path: "/events/turn-start" } } } });
  fs.writeFileSync(path.join(env.HOME, ".aify", "credentials", "echo.key"), `${KEY}-echo\n`);
  const result = await runHook(env, HOOK_INPUT);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(reflecting.seen.length, 1, "control: the echoing service was asked and answered");
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "HEALTHY RULE");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));
});

test("END TO END, EVERY NON-ANSWER EXITS 0 WITH NOTHING ADDED AND NO KEY PRINTED", async (t) => {
  const svc = await service(t, answer("UNUSED"));
  const cases = [
    ["no agent id", host(t, { endpoint: svc.endpoint, env: { AIFY_AGENT_ID: "" } }), HOOK_INPUT],
    ["input that is not JSON", host(t, { endpoint: svc.endpoint }), "{not json"],
    ["no session id", host(t, { endpoint: svc.endpoint }), JSON.stringify({ cwd: "C:/x" })],
    ["a credential aify-env would refuse", host(t, { endpoint: svc.endpoint, credential: `${KEY}\r\n` }), HOOK_INPUT],
    ["an unreadable registry", host(t, { endpoint: svc.endpoint, env: { AIFY_SERVICE_REGISTRY: path.join(os.tmpdir(), "no-such-registry.json") } }), HOOK_INPUT],
  ];
  for (const [name, env, input] of cases) {
    const result = await runHook(env, input);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, "", `${name} printed context`);
    assert.doesNotMatch(result.stderr, new RegExp(KEY), name);
  }
  assert.equal(svc.seen.length, 0, "a refused case still called the service");
});

test("END TO END, INPUT THAT NEVER ENDS IS CUT AT THE DEADLINE: exit 0, nothing added", { timeout: 10000 }, async (t) => {
  const svc = await service(t, answer("UNUSED"));
  const result = await runHook(host(t, { endpoint: svc.endpoint }), null);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  // Node's own start is outside the runner's deadline: under a full suite's load one run took 3316 ms in all, against
  // a 1600 ms backstop counted from after module load. A hang is still caught: this test's own timeout ends it.
  assert.ok(result.took < TURN_START_DEADLINE_MS + 5000, `took ${result.took} ms`);
  assert.equal(svc.seen.length, 0);
});

test("END TO END, A SERVICE THAT NEVER ANSWERS IS CUT AT ITS BUDGET: exit 0, nothing added", { timeout: 10000 }, async (t) => {
  const svc = await service(t, never);
  const result = await runHook(host(t, { endpoint: svc.endpoint }), HOOK_INPUT);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(svc.seen.length, 1);
  // Node's own start is outside the runner's deadline: under a full suite's load one run took 3316 ms in all, against
  // a 1600 ms backstop counted from after module load. A hang is still caught: this test's own timeout ends it.
  assert.ok(result.took < TURN_START_DEADLINE_MS + 5000, `took ${result.took} ms`);
});
