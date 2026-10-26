// A hermes gateway is ready only when its socket opens, and a start that cannot serve says why at once (0.9.10: the
// start moved here from the comms bridge). Driven against a fake hermes: spawn, index and socket are stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { bootFailure, ownerEnv, startGateway } from '../lib/hermes-gateway-start.mjs';

const TOKEN = 'tok-123';
// Nothing listens: the gateway, its index and its socket are fakes; the port is only what the start is told.
const PORT = 9341;
const page = (token) => `<script>window.__HERMES_SESSION_TOKEN__ = "${token}";</script>`;

/**
 * A fake hermes. `serves` is when the index starts answering (false: never); `socket` whether /api/ws opens. Its index
 * carries the preset HERMES_DASHBOARD_SESSION_TOKEN, as hermes' does (web_server.py), unless `servesToken` says otherwise.
 */
function fakeHermes(t, { serves = 0, socket = true, writes = '', exitWith = null, servesToken = null } = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-gateway-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const calls = [];
  let started = null;
  let preset = null;
  const spawn = (cmd, args, options) => {
    preset = options.env.HERMES_DASHBOARD_SESSION_TOKEN;
    calls.push({ cmd, args, options });
    if (writes) fs.writeSync(options.stdio[2], writes);
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    started = Date.now();
    if (exitWith !== null) setImmediate(() => child.emit('exit', exitWith, null));
    return child;
  };
  const fetchImpl = async () => {
    if (serves === false || started === null || Date.now() - started < serves) throw new Error('ECONNREFUSED');
    return { ok: true, text: async () => page(servesToken ?? preset) };
  };
  class WebSocketImpl {
    #listeners = {};
    constructor(url) { this.url = url; setImmediate(() => this.#listeners[socket ? 'open' : 'error']?.()); }
    addEventListener(name, listener) { this.#listeners[name] = listener; }
    close() {}
  }
  return { logDir, calls, spawn, fetchImpl, WebSocketImpl };
}

test('READY WHEN THE SOCKET OPENS: the start answers the socket url, tied to the agent and not to this process', async (t) => {
  const h = fakeHermes(t, { serves: 30 });
  const spawned = [];
  const ready = await startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, env: { PATH: 'x', HERMES_PARENT_NONCE: 'inherited' },
    token: TOKEN, onSpawn: (pid) => spawned.push(pid), spawn: h.spawn, fetchImpl: h.fetchImpl, WebSocketImpl: h.WebSocketImpl, intervalMs: 5 });
  assert.deepEqual(ready, { port: PORT, token: TOKEN, wsUrl: `ws://127.0.0.1:${PORT}/api/ws?token=${TOKEN}`, pid: 4242 });
  const [{ cmd, args, options }] = h.calls;
  assert.equal(cmd, 'hermes');
  assert.deepEqual(args, ['dashboard', '--port', String(PORT), '--host', '127.0.0.1', '--no-open', '--skip-build']);
  assert.equal(options.detached, true, 'an aify-env restart must not end it');
  assert.equal(options.env.HERMES_PARENT_PID, '777', "hermes' watchdog ends it with its agent");
  assert.equal(options.env.HERMES_PARENT_NONCE, '', 'an inherited nonce describes some other parent');
  assert.equal(options.env.HERMES_YOLO_MODE, '1');
  assert.equal(options.env.HERMES_DASHBOARD_SESSION_TOKEN, TOKEN, 'hermes serves the token the launcher minted');
  assert.equal(options.env.AIFY_HERMES_GATEWAY_URL, ready.wsUrl, "the gateway's MCP servers read its address from its own environment");
  assert.equal(options.env.AIFY_HERMES_GATEWAY_TOKEN, TOKEN);
  assert.deepEqual(spawned, [4242]);
});

test('A GATEWAY SERVING ANOTHER TOKEN IS REFUSED: its MCP servers would hold a wrong address', async (t) => {
  const h = fakeHermes(t, { servesToken: 'not-the-preset' });
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, intervalMs: 5 }), /serves a session token other than the one it was started with/);
});

test('A MINTED TOKEN is fresh per start and safe in a url', async (t) => {
  const h = fakeHermes(t);
  const run = () => startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, intervalMs: 5 });
  const [a, b] = [await run(), await run()];
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
});

test('AN INDEX WITHOUT A SOCKET IS NOT READY: the start waits to its deadline and says so', async (t) => {
  const h = fakeHermes(t, { socket: false });
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, readyTimeoutMs: 60, intervalMs: 5 }), /did not serve within 60 ms: .*refused \/api\/ws/);
});

test('AN EXIT BEFORE SERVING refuses at once with its last line, and its token never leaves', async (t) => {
  const h = fakeHermes(t, { serves: false, exitWith: 1, writes: 'starting on token=s3cret\nOSError: [Errno 98] address in use token=s3cret\n' });
  const started = Date.now();
  const spawned = [];
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    onSpawn: (pid) => spawned.push(pid), WebSocketImpl: h.WebSocketImpl, intervalMs: 5 }), (error) => {
    assert.match(error.message, /exited before it served: exit 1; it last wrote: OSError: \[Errno 98\] address in use token=<redacted>/);
    assert.doesNotMatch(error.message, /s3cret/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'the ten-minute deadline was not waited out');
  assert.deepEqual(spawned, [4242], 'a gateway that never served joined the lease all the same');
});

test('THE KNOWN BOOT FAILURE refuses at once, before the deadline', async (t) => {
  const h = fakeHermes(t, { serves: false, writes: 'Installing TUI dependencies...\nnpm error Missing script: "build"\n' });
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, intervalMs: 5 }), /TUI dependency build failed/);
  assert.equal(bootFailure('dashboard listening on 127.0.0.1:9341'), '', 'CONTROL: an ordinary boot line is no failure');
});

test('NO LAUNCHER PID, NO OWNER: nothing is set rather than a wrong parent', () => {
  for (const pid of [undefined, 0, -1, 'x', 1.5]) assert.deepEqual(ownerEnv(pid), {}, String(pid));
  assert.deepEqual(ownerEnv(12), { HERMES_PARENT_PID: '12', HERMES_PARENT_START_MARKER: '', HERMES_PARENT_NONCE: '' });
});
