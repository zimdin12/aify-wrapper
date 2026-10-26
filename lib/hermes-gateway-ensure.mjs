// The launcher's half of an agent's hermes gateway (0.9.10): ask aify-env for its port, start the gateway there from
// the launcher's own environment, and tell aify-env the pid. What `hermes-managed-host.js ensure-host` in comms'
// bridge did, minus the decisions aify-env now owns (which port, which lifetime owns it, ending an older one's).
//
// A MANAGED LAUNCH NEEDS aify-env and stops here with the reason. A RESIDENT (hand) launch works without one, as it
// did before the move (operator, 2026-10-26): when no aify-env answers, it starts the gateway on its agent's hashed
// port, joined to the lease like any other, and says that aify-env's record and doctor row cannot see it. A busy port
// fails the start (the gateway must serve the token it was started with), so it never adopts another agent's gateway.
//
// ROUTING IS DESCRIPTOR-ONLY, re-read for every request: `<home>/.aify/env/<instance>.json`, a loopback http url and
// nothing else (the rule comms' hook poster uses). No key travels: the route is turn-event's loopback posture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIFETIME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUEST_MS = 15_000; // prepare can end an older gateway first, which waits on the OS
const RESIDENTS = 'residents';

// aify-env's port rule (lib/hermes-gateway-ports.mjs `hashedPort`), copied for the resident start without aify-env;
// the known answers in this module's test are the ones aify-env's own test pins.
const PORT_BASE = 8642;
const PORT_SPAN = 1000;
const RESERVED_PORTS = new Set([8800, 8801, 8802]);

/** PURE. The start of `agentId`'s search in aify-env's rule: FNV-1a of the id in the range, past a reserved port. */
export function hashedPort(agentId) {
  const id = String(agentId);
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const offset = hash % PORT_SPAN;
  for (let i = 0; i < PORT_SPAN; i += 1) {
    const port = PORT_BASE + ((offset + i) % PORT_SPAN);
    if (!RESERVED_PORTS.has(port)) return port;
  }
  return PORT_BASE + offset;
}

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
 * @param {{agentId: string, env?: object, start: Function, attach?: Function, stop: Function, logDir: string,
 *          endpoint?: Function, fetchImpl?: Function}} input  `stop(pid)` ends a gateway aify-env would not record
 * @returns {Promise<{port: number, token: string, wsUrl: string}>}
 */
export async function ensureGateway({ agentId, env = process.env, start, attach = () => {}, stop, logDir,
  endpoint = envEndpoint, fetchImpl = fetch, note = (line) => process.stderr.write(`${line}\n`) }) {
  const instance = String(env.AIFY_ENV_INSTANCE || '');
  const lifetime = String(env.AIFY_LIFETIME || '');
  if (!INSTANCE.test(instance) || !LIFETIME.test(lifetime)) {
    throw new Error('this launch has no aify-env lifetime, and a hermes gateway needs one: aify-env must be running on this host (ask `aify-env doctor`)');
  }
  // FAILS CLOSED WITHOUT A LEASE: the lease pid is what ends the gateway with its agent (hermes' parent watchdog and
  // the lease's own stop). Without one the gateway would outlive its launcher unseen (review of 6959d44, F4).
  const ownerPid = Number(env.AIFY_AGENT_LEASE);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new Error("this launch holds no agent lease, and a hermes gateway without one would outlive its agent: relaunch once the lease is free");
  }
  const unrecorded = async (why) => {
    const started = await start({ port: hashedPort(agentId), ownerPid, logDir, env, onSpawn: attach });
    note(`aify-env ${why}: the hermes gateway started on port ${started.port} without aify-env's record, so aify-env doctor cannot see it until a launch with aify-env running`);
    return { port: started.port, token: started.token, wsUrl: started.wsUrl };
  };
  const base = endpoint({ env, instance });
  if (!base && instance === RESIDENTS) return unrecorded('is not running');
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
  let prepared;
  try { prepared = await ask({ action: 'prepare' }); } catch (error) {
    // A descriptor left by an aify-env that is gone: nothing listens. A refusal or a timeout is an answer, and stops.
    if (instance === RESIDENTS && error?.cause?.code === 'ECONNREFUSED') return unrecorded('does not answer');
    throw error;
  }
  if (prepared.live) return { port: prepared.port, token: prepared.token, wsUrl: prepared.wsUrl };
  // The lease is joined at spawn, inside the start: a gateway that never serves still holds the port until it ends.
  const started = await start({ port: prepared.port, ownerPid, logDir, env, onSpawn: attach });
  // A gateway aify-env will not record is no lifetime's: no later launch could end it, so it is ended here.
  try { await ask({ action: 'register', port: started.port, pid: started.pid }); }
  catch (error) { await stop(started.pid); throw error; }
  return { port: started.port, token: started.token, wsUrl: started.wsUrl };
}
