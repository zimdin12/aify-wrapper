// The launcher's half of an agent's hermes gateway (0.9.10): ask aify-env for its port, start the gateway there from
// the launcher's own environment, and tell aify-env the pid. What `hermes-managed-host.js ensure-host` in comms'
// bridge did, minus the decisions aify-env now owns (which port, which lifetime owns it, ending an older one's).
//
// aify-env IS REQUIRED. A hermes launch with no aify-env holding its instance stops here with the reason, as a
// managed spawn already does; nothing falls back to deciding ports or ending gateways in the launcher.
//
// ROUTING IS DESCRIPTOR-ONLY, re-read for every request: `<home>/.aify/env/<instance>.json`, a loopback http url and
// nothing else (the rule comms' hook poster uses). No key travels: the route is turn-event's loopback posture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIFETIME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUEST_MS = 15_000; // prepare can end an older gateway first, which waits on the OS

/** The aify-env serving `instance` on this host, from its descriptor, or null. */
export function envEndpoint({ env = process.env, instance, readFile = (file) => fs.readFileSync(file, 'utf8') }) {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  let descriptor;
  try { descriptor = JSON.parse(readFile(path.join(home, '.aify', 'env', `${instance}.json`))); } catch { return null; }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || descriptor.instance !== instance
    || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0 || typeof descriptor.url !== 'string'
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(descriptor.url)) return null;
  return new URL(descriptor.url);
}

/**
 * The gateway for `agentId`'s current lifetime: the live one aify-env hands back, or one started on the port it gives.
 * @param {{agentId: string, env?: object, start: Function, attach?: Function, logDir: string,
 *          endpoint?: Function, fetchImpl?: Function}} input
 * @returns {Promise<{port: number, token: string, wsUrl: string}>}
 */
export async function ensureGateway({ agentId, env = process.env, start, attach = () => {}, logDir,
  endpoint = envEndpoint, fetchImpl = fetch }) {
  const instance = String(env.AIFY_ENV_INSTANCE || '');
  const lifetime = String(env.AIFY_LIFETIME || '');
  if (!INSTANCE.test(instance) || !LIFETIME.test(lifetime)) {
    throw new Error('this launch has no aify-env lifetime, and a hermes gateway needs one: aify-env must be running on this host (ask `aify-env doctor`)');
  }
  const base = endpoint({ env, instance });
  if (!base) throw new Error(`no aify-env serves instance '${instance}' on this host (its descriptor is missing or invalid)`);
  const ask = async (body) => {
    const response = await fetchImpl(new URL(`/agents/${encodeURIComponent(agentId)}/gateway`, base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance, lifetime, ...body }),
      redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(REQUEST_MS),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || answer.ok !== true) throw new Error(`aify-env refused the gateway ${body.action}: ${answer.reason || response.status}`);
    return answer;
  };
  const prepared = await ask({ action: 'prepare' });
  if (prepared.live) return { port: prepared.port, token: prepared.token, wsUrl: prepared.wsUrl };
  // The lease is joined at spawn, inside the start: a gateway that never serves still holds the port until it ends.
  const started = await start({ port: prepared.port, ownerPid: Number(env.AIFY_AGENT_LEASE), logDir, env, onSpawn: attach });
  await ask({ action: 'register', port: started.port, pid: started.pid });
  return { port: started.port, token: started.token, wsUrl: started.wsUrl };
}
