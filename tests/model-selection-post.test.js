// The transport alone: what leaves this process, to where, and what is refused before any descriptor read or send.
// Env's own suite owns admission and native ordering; the reporter suite owns the producer that builds these bodies.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MODEL_POST_TIMEOUT_MS, postModelSelection } from "../lib/model-selection-post.mjs";

const AGENT = "test-agent", INSTANCE = "test-instance", LIFETIME = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const SESSION = "11111111-2222-3333-4444-555555555555", RECORD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGIN = "http://127.0.0.1:45678";
const DESCRIPTOR = { url: ORIGIN, instance: INSTANCE, pid: 4242, startedAt: "2026-11-06T18:00:00.000Z" };
const launch = (value) => ({ instance: INSTANCE, lifetime: LIFETIME, harness: "claude", source: "launch", session: "", transcriptIdentity: null, endOffset: null, recordUuid: null, value });
const completion = (value) => ({ instance: INSTANCE, lifetime: LIFETIME, harness: "claude", source: "model-command", session: SESSION,
  transcriptIdentity: "0123456789abcdef".repeat(4), endOffset: 4096, recordUuid: RECORD, value });
const without = (body, key) => { const copy = { ...body }; delete copy[key]; return copy; };

/** One isolated attempt: injected fetch always; an injected descriptor read unless `realFile` hands the module's own reader an isolated home. */
async function attempt({ agent = AGENT, body = launch("provider/a"), env = {}, home = "unused-home", descriptor = DESCRIPTOR, read, realFile = false, respond } = {}) {
  const sends = [], reads = [];
  const fetchImpl = async (url, options) => { sends.push({ url: String(url), options }); return respond ? respond(options) : { ok: true }; };
  const injected = read || ((file) => { reads.push(file); return typeof descriptor === "string" ? descriptor : JSON.stringify(descriptor); });
  const options = { env: { AIFY_ENV_INSTANCE: INSTANCE, AIFY_LIFETIME: LIFETIME, ...env }, home, fetchImpl, ...(realFile ? {} : { read: injected }) };
  const posted = await postModelSelection(agent, body, options);
  return { posted, sends, reads };
}
function isolatedHome(t, descriptor = DESCRIPTOR) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-model-post-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".aify", "env"), { recursive: true });
  fs.writeFileSync(path.join(home, ".aify", "env", `${INSTANCE}.json`), JSON.stringify(descriptor));
  return home;
}
const HOME_VARIABLE = process.platform === "win32" ? "USERPROFILE" : "HOME";
const OTHER_VARIABLE = process.platform === "win32" ? "HOME" : "USERPROFILE";

test("every agreed launch and completion form is sent once, unchanged, to its instance's loopback route without redirects or credentials", async (t) => {
  const home = isolatedHome(t);
  for (const body of [launch(null), launch("provider/a"), completion("provider/b"), completion(""), completion(null)]) {
    let cancelled = 0;
    const { posted, sends } = await attempt({ body, env: { [HOME_VARIABLE]: home }, realFile: true,
      respond: () => ({ ok: true, body: { cancel: async () => { cancelled++; } } }) });
    const label = `${body.source} value ${JSON.stringify(body.value)}`;
    assert.equal(posted, true, label); assert.equal(sends.length, 1, label);
    const [{ url, options }] = sends;
    assert.equal(url, `${ORIGIN}/agents/${AGENT}/model-selection`, label);
    assert.equal(options.method, "POST", label); assert.deepEqual(options.headers, { "content-type": "application/json" }, label);
    assert.deepEqual(JSON.parse(options.body), body, label);
    assert.equal(options.redirect, "manual", label); assert.equal(options.credentials, "omit", label);
    assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted, `${label}: a live deadline signal`);
    assert.equal(cancelled, 1, `${label}: the response body is released, not left holding the connection`);
  }
});

test("the descriptor comes from the platform's home variable, and from the supplied home only when that variable is absent", async (t) => {
  const own = isolatedHome(t, { ...DESCRIPTOR, url: "http://127.0.0.1:1111" });
  const other = isolatedHome(t, { ...DESCRIPTOR, url: "http://127.0.0.1:2222" });
  const supplied = isolatedHome(t, { ...DESCRIPTOR, url: "http://127.0.0.1:3333" });
  const chosen = await attempt({ env: { [HOME_VARIABLE]: own, [OTHER_VARIABLE]: other }, home: supplied, realFile: true });
  assert.equal(chosen.sends[0]?.url, `http://127.0.0.1:1111/agents/${AGENT}/model-selection`);
  const fallback = await attempt({ env: { [OTHER_VARIABLE]: other }, home: supplied, realFile: true });
  assert.equal(fallback.sends[0]?.url, `http://127.0.0.1:3333/agents/${AGENT}/model-selection`);
});

test("a malformed or foreign envelope or agent id is refused before any descriptor read or send", async (t) => {
  const cases = {
    "no envelope": { body: null },
    "agent id that is a path": { agent: "../agent" },
    "agent id that is a device name": { agent: "CON" },
    "another harness": { body: { ...launch("provider/a"), harness: "codex" } },
    "unknown source": { body: { ...completion("provider/a"), source: "model-switch" } },
    "an unagreed extra field": { body: { ...completion("provider/a"), firedAtUs: 1 } },
    "instance that could leave the descriptor folder": { body: { ...launch("provider/a"), instance: "../x" }, env: { AIFY_ENV_INSTANCE: "../x" } },
    "instance of another env": { body: { ...launch("provider/a"), instance: "other-instance" } },
    "lifetime of another launch": { body: { ...launch("provider/a"), lifetime: "00000000-0000-4000-8000-000000000000" } },
    "lifetime that is not a UUID": { body: { ...launch("provider/a"), lifetime: "not-a-uuid" }, env: { AIFY_LIFETIME: "not-a-uuid" } },
    "value with a newline": { body: launch("provider/a\n") },
    "value with a C1 control": { body: completion("provider/a\u0085") },
    "value that is not a string": { body: completion(5) },
    "value missing": { body: without(completion("provider/a"), "value") },
    "launch carrying a session": { body: { ...launch("provider/a"), session: SESSION } },
    "launch carrying a transcript identity": { body: { ...launch("provider/a"), transcriptIdentity: "0123456789abcdef".repeat(4) } },
    "launch carrying offset 0": { body: { ...launch("provider/a"), endOffset: 0 } },
    "launch carrying a record": { body: { ...launch("provider/a"), recordUuid: RECORD } },
    "completion with the launch session sentinel": { body: { ...completion("provider/a"), session: "" } },
    "completion with no record": { body: { ...completion("provider/a"), recordUuid: null } },
    "completion with a short transcript identity": { body: { ...completion("provider/a"), transcriptIdentity: "0".repeat(63) } },
    "completion with a transcript identity and trailing text": { body: { ...completion("provider/a"), transcriptIdentity: `${"0".repeat(64)}x` } },
    "completion at offset 0": { body: { ...completion("provider/a"), endOffset: 0 } },
    "completion at a negative offset": { body: { ...completion("provider/a"), endOffset: -4096 } },
    "completion at a fractional offset": { body: { ...completion("provider/a"), endOffset: 1.5 } },
    "completion at an offset written as text": { body: { ...completion("provider/a"), endOffset: "4096" } },
    "completion past the safe-integer range": { body: { ...completion("provider/a"), endOffset: 2 ** 53 } },
    "completion with no offset": { body: { ...completion("provider/a"), endOffset: null } },
  };
  for (const [name, input] of Object.entries(cases)) await t.test(name, async () => {
    const { posted, sends, reads } = await attempt(input);
    assert.deepEqual({ posted, reads: reads.length, sends: sends.length }, { posted: false, reads: 0, sends: 0 });
  });
});

test("a missing, unreadable, malformed or foreign descriptor sends nothing", async (t) => {
  const cases = {
    "missing": { read: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } },
    "not JSON": { descriptor: "{" },
    "null": { descriptor: "null" },
    "an array": { descriptor: "[]" },
    "another instance's": { descriptor: { ...DESCRIPTOR, instance: "other-instance" } },
    "pid 0": { descriptor: { ...DESCRIPTOR, pid: 0 } },
    "pid written as text": { descriptor: { ...DESCRIPTOR, pid: "4242" } },
    "no pid": { descriptor: without(DESCRIPTOR, "pid") },
    "no start time": { descriptor: without(DESCRIPTOR, "startedAt") },
    "a start time that is not a date": { descriptor: { ...DESCRIPTOR, startedAt: "yesterday" } },
    "no url": { descriptor: without(DESCRIPTOR, "url") },
    "a url that is not a string": { descriptor: { ...DESCRIPTOR, url: [ORIGIN] } },
  };
  for (const [name, input] of Object.entries(cases)) await t.test(name, async () => {
    const { posted, sends } = await attempt(input);
    assert.deepEqual({ posted, sends: sends.length }, { posted: false, sends: 0 });
  });
});

test("only a bare http://127.0.0.1:port origin is a destination", async (t) => {
  for (const url of ["http://example.com:45678", "https://127.0.0.1:45678", "http://localhost:45678", "http://[::1]:45678", "http://127.0.0.2:45678",
    "http://user:secret@127.0.0.1:45678", "http://127.0.0.1:45678@example.com", "http://127.0.0.1:45678/elsewhere", "http://127.0.0.1:45678?next=x",
    "http://127.0.0.1:45678\n", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:99999"]) {
    await t.test(JSON.stringify(url), async () => {
      const { posted, sends } = await attempt({ descriptor: { ...DESCRIPTOR, url } });
      assert.deepEqual({ posted, sends: sends.length }, { posted: false, sends: 0 });
    });
  }
});

test("a redirected, refused or failed response is not posted, and is neither followed nor retried", async (t) => {
  const responses = {
    "a redirect": () => ({ ok: false, status: 302, headers: { location: "http://example.com/" } }),
    "a server error": () => ({ ok: false, status: 500 }),
    "a network failure": () => { throw new TypeError("fetch failed"); },
  };
  for (const [name, respond] of Object.entries(responses)) await t.test(name, async () => {
    const { posted, sends } = await attempt({ respond });
    assert.deepEqual({ posted, sends: sends.length }, { posted: false, sends: 1 });
  });
});

test("a receiver that never answers is abandoned at the deadline", { timeout: MODEL_POST_TIMEOUT_MS + 10_000 }, async () => {
  const started = performance.now();
  const { posted } = await attempt({ respond: ({ signal }) => new Promise((resolve, reject) => {
    // An open socket keeps the loop alive; AbortSignal.timeout's own timer does not. Without a signal this hangs until the test timeout.
    const socket = setTimeout(() => {}, MODEL_POST_TIMEOUT_MS + 9_000);
    signal?.addEventListener("abort", () => { clearTimeout(socket); reject(signal.reason); }, { once: true });
  }) });
  const waited = performance.now() - started;
  assert.equal(posted, false);
  assert.ok(waited >= MODEL_POST_TIMEOUT_MS - 50 && waited < MODEL_POST_TIMEOUT_MS + 5000, `abandoned after ${Math.round(waited)} ms`);
});
