// A hermes launch gets its gateway through aify-env (0.9.10): aify-env says which port or hands back the live one, the
// launcher starts the gateway from its own environment, and registers the pid. aify-env and the gateway are stand-ins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureGateway, envEndpoint, hashedPort } from '../lib/hermes-gateway-ensure.mjs';

const LIFETIME = '11111111-1111-4111-8111-111111111111';
const ENV = { AIFY_ENV_INSTANCE: 'default', AIFY_LIFETIME: LIFETIME, AIFY_AGENT_LEASE: '700', AIFY_AGENT_ID: 'pc-manager', SECRET: 'kept' };
const BASE = new URL('http://127.0.0.1:8802');

/** A fake aify-env answering each action, recording what it was asked. */
function aifyEnv(answers) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url: String(url), body });
    const answer = answers[body.action] ?? { status: 500, body: {} };
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  return { asked, fetchImpl };
}

test('NO LIVE GATEWAY: start on the port aify-env gave, from this launch\'s own environment, then register its pid', async () => {
  const env = aifyEnv({ prepare: { status: 200, body: { ok: true, port: 9341, live: false } }, register: { status: 200, body: { ok: true } } });
  const starts = [];
  const attached = [];
  const gateway = await ensureGateway({ agentId: 'pc-manager', env: ENV, logDir: 'L', endpoint: () => BASE, fetchImpl: env.fetchImpl,
    start: async (input) => { starts.push(input); input.onSpawn(4242); return { port: input.port, token: 't', wsUrl: 'ws://127.0.0.1:9341/api/ws?token=t', pid: 4242 }; },
    attach: (pid) => attached.push(pid) });
  assert.deepEqual(gateway, { port: 9341, token: 't', wsUrl: 'ws://127.0.0.1:9341/api/ws?token=t' });
  assert.deepEqual(starts.map(({ port, ownerPid, logDir }) => ({ port, ownerPid, logDir })), [{ port: 9341, ownerPid: 700, logDir: 'L' }]);
  assert.equal(starts[0].env, ENV, "the gateway starts with the launcher's environment: the agent's id and secrets");
  assert.deepEqual(attached, [4242], 'the gateway joins the agent lease, at spawn');
  assert.deepEqual(env.asked.map(({ url, body }) => [url, body]), [
    ['http://127.0.0.1:8802/agents/pc-manager/gateway', { instance: 'default', lifetime: LIFETIME, action: 'prepare' }],
    ['http://127.0.0.1:8802/agents/pc-manager/gateway', { instance: 'default', lifetime: LIFETIME, action: 'register', port: 9341, pid: 4242 }],
  ]);
});

test('A LIVE GATEWAY IS REUSED: nothing starts and nothing registers', async () => {
  const env = aifyEnv({ prepare: { status: 200, body: { ok: true, port: 9341, live: true, token: 't', wsUrl: 'ws://x' } } });
  const gateway = await ensureGateway({ agentId: 'pc-manager', env: ENV, logDir: 'L', endpoint: () => BASE, fetchImpl: env.fetchImpl,
    start: async () => assert.fail('a live gateway was started again') });
  assert.deepEqual(gateway, { port: 9341, token: 't', wsUrl: 'ws://x' });
  assert.equal(env.asked.length, 1);
});

test('NO aify-env, NO GATEWAY: a launch without a lifetime or a serving aify-env stops with the reason', async () => {
  const never = async () => assert.fail('nothing may start');
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: { ...ENV, AIFY_LIFETIME: '' }, logDir: 'L', start: never }),
    /has no aify-env lifetime/);
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: ENV, logDir: 'L', start: never, endpoint: () => null }),
    /no aify-env serves instance 'default'/);
});

test('A REFUSAL IS SAID, AND A SUPERSEDED LAUNCH STARTS NOTHING', async () => {
  const env = aifyEnv({ prepare: { status: 409, body: { ok: false, reason: 'not-current' } } });
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: ENV, logDir: 'L', endpoint: () => BASE, fetchImpl: env.fetchImpl,
    start: async () => assert.fail('a superseded launch started a gateway') }), /refused the gateway prepare: not-current/);
});

test('THE DESCRIPTOR names a loopback aify-env for its own instance, or nothing', () => {
  const read = (body) => () => JSON.stringify(body);
  const good = { instance: 'default', pid: 12, url: 'http://127.0.0.1:8802', startedAt: '2026-10-26T00:00:00Z' };
  assert.equal(String(envEndpoint({ env: { USERPROFILE: 'C:/h', HOME: '/h' }, instance: 'default', readFile: read(good) })), 'http://127.0.0.1:8802/');
  for (const [bad, why] of [
    [{ ...good, url: 'http://10.0.0.5:8802' }, 'not loopback'],
    [{ ...good, url: 'https://127.0.0.1:8802' }, 'not plain http'],
    [{ ...good, instance: 'other' }, 'another instance'],
    [{ ...good, pid: 0 }, 'no pid'],
  ]) assert.equal(envEndpoint({ env: {}, instance: 'default', readFile: read(bad) }), null, why);
  assert.equal(envEndpoint({ env: {}, instance: 'default', readFile: () => { throw new Error('ENOENT'); } }), null, 'no descriptor');
});

test('NO LEASE, NO GATEWAY: a launch holding no agent lease is refused before aify-env is asked (review of 6959d44, F4)', async () => {
  for (const lease of ['', '0', 'x']) {
    const env = aifyEnv({ prepare: { status: 200, body: { ok: true, port: 9341, live: false } } });
    await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: { ...ENV, AIFY_AGENT_LEASE: lease }, logDir: 'L', endpoint: () => BASE,
      fetchImpl: env.fetchImpl, start: async () => assert.fail('a gateway with no owner was started') }), /holds no agent lease/, lease);
    assert.equal(env.asked.length, 0, `${JSON.stringify(lease)}: aify-env was asked anyway`);
  }
});

test('A GATEWAY aify-env WILL NOT RECORD IS ENDED: no later launch could end it', async () => {
  const env = aifyEnv({ prepare: { status: 200, body: { ok: true, port: 9341, live: false } }, register: { status: 409, body: { ok: false, reason: 'not-prepared' } } });
  const stopped = [];
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: ENV, logDir: 'L', endpoint: () => BASE, fetchImpl: env.fetchImpl,
    start: async (input) => ({ port: input.port, token: 't', wsUrl: 'ws://x', pid: 4242 }), stop: async (pid) => { stopped.push(pid); } }),
  /refused the gateway register: not-prepared/);
  assert.deepEqual(stopped, [4242]);
});

const RESIDENT = { ...ENV, AIFY_ENV_INSTANCE: 'residents' };
const refused = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }); };

test('A HAND LAUNCH WORKS WITHOUT aify-env (operator, 2026-10-26): it starts on its agent\'s hashed port, joins the lease, records nothing, and says so', async () => {
  for (const [why, endpoint] of [['no descriptor', () => null], ['a descriptor nothing answers', () => BASE]]) {
    const starts = [];
    const attached = [];
    const notes = [];
    const gateway = await ensureGateway({ agentId: 'pc-manager', env: RESIDENT, logDir: 'L', endpoint, fetchImpl: refused,
      start: async (input) => { starts.push(input); input.onSpawn(4242); return { port: input.port, token: 't', wsUrl: 'ws://127.0.0.1:8868/api/ws?token=t', pid: 4242 }; },
      attach: (pid) => attached.push(pid), note: (line) => notes.push(line) });
    assert.deepEqual(gateway, { port: 8868, token: 't', wsUrl: 'ws://127.0.0.1:8868/api/ws?token=t' }, why);
    assert.deepEqual(starts.map(({ port, ownerPid }) => ({ port, ownerPid })), [{ port: 8868, ownerPid: 700 }], why);
    assert.equal(starts[0].env, RESIDENT, `${why}: the gateway starts with the launcher's environment`);
    assert.deepEqual(attached, [4242], `${why}: the gateway joins the agent lease`);
    assert.match(notes.join('\n'), /without aify-env's record/, why);
  }
});

test('ONLY A HAND LAUNCH, AND ONLY WHEN NOTHING ANSWERS: a managed launch, a refusal and a timeout still stop', async () => {
  const never = async () => assert.fail('nothing may start');
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: ENV, logDir: 'L', start: never, endpoint: () => BASE, fetchImpl: refused }),
    /fetch failed/, 'a managed launch whose aify-env is gone');
  const env = aifyEnv({ prepare: { status: 409, body: { ok: false, reason: 'not-current' } } });
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: RESIDENT, logDir: 'L', start: never, endpoint: () => BASE, fetchImpl: env.fetchImpl }),
    /refused the gateway prepare: not-current/, 'aify-env answered: a refusal is an answer');
  const slow = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: RESIDENT, logDir: 'L', start: never, endpoint: () => BASE, fetchImpl: slow }),
    /timeout/, 'a slow aify-env may be ending the older gateway on that port');
  await assert.rejects(ensureGateway({ agentId: 'pc-manager', env: { ...RESIDENT, AIFY_AGENT_LEASE: '' }, logDir: 'L', start: never, endpoint: () => null }),
    /holds no agent lease/, 'a hand launch with no lease still starts nothing');
});

test('THE PORT RULE is aify-env\'s: the values its own test pins (lib/hermes-gateway-ports.mjs)', () => {
  assert.equal(hashedPort('general-helper-gpt'), 8803, 'steps past the reserved 8800-8802');
  assert.equal(hashedPort('comms-senior-dev'), 9341);
  assert.equal(hashedPort('graph-hermes-tl'), 9341);
  assert.equal(hashedPort('pc-manager'), 8868);
  assert.equal(hashedPort('sc-coder-gpt'), 9545);
});
