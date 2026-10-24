#!/usr/bin/env node
// One local post-tool process. Never imports a network client or a runtime transcript reader.
import os from 'node:os';
import path from 'node:path';
import { activityConfiguration, activityEvent, safeAgentId } from '../lib/file-activity.mjs';

import { leaseDirectory } from '../lib/agent-lease.mjs';
import { machineIdFor, hostIsWsl } from '../lib/machine-id.mjs';
import { reportToolWorking } from '../lib/herdr-tool-state.mjs';

const firedAt = Date.now();
reportToolWorking({ env: process.env, firedAt });
try {
  const config = activityConfiguration(process.env);
  if (config.enabled && safeAgentId(process.env.AIFY_AGENT_ID)) {
    let bytes = 0, chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { chunks = null; break; }
      chunks.push(chunk);
    }
    if (chunks) {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const identity = { agentId: process.env.AIFY_AGENT_ID, instanceId: process.env.AIFY_ENV_INSTANCE,
        incarnation: process.env.AIFY_LIFETIME || null,
        machineId: machineIdFor({ platform: process.platform, hostname: os.hostname(), env: process.env, isWsl: hostIsWsl() }) };
      const record = activityEvent({ input, identity, outcome: process.argv[2], observedAt: firedAt });
      const root = leaseDirectory({ env: process.env });
      if (record && path.isAbsolute(root)) {
        const { ActivitySpool } = await import('../lib/activity-spool.mjs');
        new ActivitySpool({ ...config, directory: path.join(root, identity.agentId, 'activity-v2') }).append(record);
      }
    }
  }
} catch { /* Input/config/storage failures cannot break independent state reporting or the agent. */ }
process.exitCode = 0;
