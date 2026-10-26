// A hermes launch gets its gateway through aify-env (0.9.10): aify-env says which port or hands back the live one, the
// launcher starts the gateway from its own environment, and registers the pid. aify-env and the gateway are stand-ins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureGateway, envEndpoint } from '../lib/hermes-gateway-ensure.mjs';

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
