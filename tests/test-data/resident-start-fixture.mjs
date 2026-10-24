// Owned fixture collaborators only. Never construct a native lease or start its watch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runLease } from '../../bin/aify-agent-lease.mjs';

const [mode, ...args] = process.argv.slice(2);
globalThis.fetch = () => { throw new Error('fixture forbids HTTP'); };
const log = (entry) => fs.appendFileSync(process.env.TASK8_EVENTS, JSON.stringify(entry) + '\n');
if (mode === 'claim') {
  assert.equal(process.env.AIFY_LEASE_RESIDENT_START, undefined, 'permission must not be exported');
  const [, ...argv] = args; // The actual shell-selected helper path is retained in the receipt.
  log({ event: 'claim', args });
  process.exitCode = runLease(argv, {
    env: process.env,
    lease: () => ({ claim: () => {
      if (process.env.TASK8_DECISION === 'error') throw new Error('owned claim failure');
      return { decision: process.env.TASK8_DECISION || 'claim', stopped: [], live: { pid: 17 } };
    } }),
    watch: () => log({ event: 'watch' }),
  });
} else if (mode === 'capture') {
  assert.deepEqual(args, ['agents', 'resident-start-binding', 'task8-agent', 'claude', 'SessionStart']);
  const records = path.join(process.env.USERPROFILE, '.aify', 'residents');
  assert.deepEqual(fs.existsSync(records) ? fs.readdirSync(records) : [], [], 'capture precedes record creation');
  assert.equal(process.env.AIFY_LEASE_RESIDENT_START, undefined);
  log({ event: 'capture', args });
  process.stdout.write(process.env.TASK8_CAPTURE || '');
  process.exitCode = Number(process.env.TASK8_CAPTURE_STATUS || 0);
} else if (mode === 'snapshot') {
  assert.equal(process.env.AIFY_LEASE_RESIDENT_START, undefined);
  const records = path.join(process.env.USERPROFILE, '.aify', 'residents');
  const names = fs.existsSync(records) ? fs.readdirSync(records) : [];
  process.stdout.write(JSON.stringify({ records: names.map(name => JSON.parse(fs.readFileSync(path.join(records, name), 'utf8'))),
    events: fs.existsSync(process.env.TASK8_EVENTS) ? fs.readFileSync(process.env.TASK8_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] }));
} else if (mode === 'resident-started') {
  log({ event: 'hook', args: [mode, ...args], input: fs.readFileSync(0, 'utf8') });
} else throw new Error(`unexpected fixture mode ${mode}`);
