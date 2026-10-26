#!/usr/bin/env node
// aify-hermes-gateway ensure <agent-id>
//
// hermes-aify's gateway step (0.9.10; it was comms' `hermes-managed-host.js ensure-host`). Prints one JSON line,
// {port, token, wsUrl}, which the launcher parses and never echoes: it carries the gateway's token. The logic is
// lib/hermes-gateway-ensure.mjs; this file is its I/O. Exits 1 with the reason on stderr when there is no gateway.

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureGateway } from '../lib/hermes-gateway-ensure.mjs';
import { startGateway } from '../lib/hermes-gateway-start.mjs';

const [command, agentId] = process.argv.slice(2);
if (command !== 'ensure' || !agentId) {
  process.stderr.write('usage: aify-hermes-gateway ensure <agent-id>\n');
  process.exit(2);
}

/** The gateway is detached, so it joins the agent lease the launcher holds: the next start finds it however this ends. */
function attach(pid) {
  const lease = Number(process.env.AIFY_AGENT_LEASE);
  if (!Number.isInteger(lease) || lease <= 0 || !Number.isInteger(pid) || pid <= 0) return;
  try {
    const helper = fileURLToPath(new URL('./aify-agent-lease.mjs', import.meta.url));
    const child = spawn(process.execPath, [helper, 'attach', '--agent', agentId, '--instance', String(lease), '--pid', String(pid), '--kind', 'gateway'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the lease is a backstop; a failed attach never fails the launch */ }
}

try {
  const gateway = await ensureGateway({
    agentId, attach, logDir: path.join(os.homedir(), '.aify', 'hermes-gateways', 'logs'),
    start: (input) => startGateway({ ...input, hermesCmd: String(process.env.AIFY_HERMES_COMMAND || 'hermes').trim() || 'hermes' }),
  });
  process.stdout.write(`${JSON.stringify(gateway)}\n`);
  process.stderr.write(`[aify-hermes-gateway] gateway ready for '${agentId}' on port ${gateway.port}\n`);
} catch (error) {
  process.stderr.write(`[aify-hermes-gateway] no gateway for '${agentId}': ${error?.message || error}\n`);
  process.exit(1);
}
