// Confine every subprocess used by the actual channel installer to a denied registry fixture.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';

const record = entry => fs.appendFileSync(process.env.CHANNEL_POLICY_CALLS, JSON.stringify(entry) + '\n');
childProcess.spawnSync = (command, args, options) => {
  if (command === 'reg' && args[0] === 'export') {
    record({ kind: 'read', key: args[1] });
    return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
  }
  if (command === 'powershell') {
    assert.equal(options.env.AIFY_CHANNEL_POLICY_SUBKEY, 'SOFTWARE\\Policies\\ClaudeCode');
    record({ kind: 'write', key: options.env.AIFY_CHANNEL_POLICY_SUBKEY });
    return { status: 1, stdout: '', stderr: 'Access to the registry key is denied.' };
  }
  throw new Error(`fixture refused unexpected subprocess: ${command}`);
};
syncBuiltinESMExports();
