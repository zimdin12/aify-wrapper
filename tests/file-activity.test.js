import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { activityEvent, activityConfiguration, safeAgentId, validActivityRecord } from '../lib/file-activity.mjs';

console.log(JSON.stringify({ worker: 'file-activity', node: process.version, executable: process.execPath }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = { session_id: 'session-1', cwd: 'C:/project', tool_name: 'Read', tool_use_id: 'call-1',
  tool_input: { file_path: './src/../safe.txt', contents: 'SECRET-CONTENT', command: 'SECRET-COMMAND' },
  tool_response: { content: 'SECRET-RESPONSE' }, error: 'SECRET-ERROR' };
const identity = { agentId: 'probe', instanceId: 'fixture-instance', machineId: 'win32:fixture', incarnation: null };
const make = (value = input, outcome = 'success', source = identity) => activityEvent({ input: value, identity: source, outcome, observedAt: 1000 });
function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-hook-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_|HERMES_SESSION_ID$|NODE_OPTIONS$)/i.test(k)));
  for (const k of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'HERMES_HOME']) env[k] = dir;
  Object.assign(env, { AIFY_AGENT_ID: 'probe', AIFY_ENV_INSTANCE: 'fixture-instance', AIFY_AGENT_LEASE_DIR: dir, AIFY_FILE_ACTIVITY: '1' }, extra);
  const run = (body, outcome = 'success') => spawnSync(process.execPath, [path.join(ROOT, 'bin/aify-tool-event.mjs'), outcome], {
    env, input: typeof body === 'string' ? body : JSON.stringify(body), encoding: 'utf8', timeout: 10_000,
  });
  return { dir, env, run };
}

test('only approved file-tool fields reach immutable event bytes', () => {
  const record = make();
  assert.equal(record.source.sessionId, 'session-1');
  assert.equal(record.source.incarnation, null);
  assert.equal(record.adapter, 'claude-file-path-v1');
  assert.equal(record.event.path.canonical, 'C:/project/safe.txt');
  assert.equal(record.event.operation, 'read');
  assert.equal(record.event.outcome, 'success');
  assert.match(record.event.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(record).includes('SECRET'), false, 'raw tool fields leaked');
  assert.equal(validActivityRecord(record), true);
  assert.equal(safeAgentId(identity.agentId), true);
  for (const tool of ['Write', 'Edit']) assert.equal(make({ ...input, tool_name: tool }, 'failure').event.operation, 'write');
  assert.equal(make(input, 'failure').event.outcome, 'failure');
});

for (const [name, body, source] of [
  ['missing session', { ...input, session_id: undefined }, identity],
  ['missing agent', input, { ...identity, agentId: '' }],
  ['missing instance', input, { ...identity, instanceId: '' }],
  ['missing machine', input, { ...identity, machineId: '' }],
  ['subagent ambiguity', { ...input, agent_id: 'child' }, identity],
  ['parent session ambiguity', { ...input, parent_session_id: 'parent' }, identity],
  ['malformed path', { ...input, tool_input: { file_path: 7 } }, identity],
  ['relative cwd', { ...input, cwd: 'relative' }, identity],
  ['missing file field', { ...input, tool_input: { path: 'other' } }, identity],
]) test(`refuse ${name} instead of borrowing identity or paths`, () => assert.equal(make(body, 'success', source), null));

test('Bash with a file-looking command produces no spool line; Read positive control does', () => {
  const { run, dir } = fixture();
  const bash = run({ ...input, tool_name: 'Bash', tool_input: { command: 'cat secret.txt', file_path: 'bait.txt' } });
  assert.equal(bash.status, 0, bash.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'probe', 'activity-v2')), false);
  const read = run(input);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout + read.stderr, '');
  const directory = path.join(dir, 'probe', 'activity-v2');
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const line = JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8'));
  assert.equal(line.record.event.tool, 'Read');
});

test('disabled and malformed configuration never append', () => {
  assert.equal(activityConfiguration({}).enabled, false);
  assert.throws(() => activityConfiguration({ AIFY_FILE_ACTIVITY: 'yes' }));
  for (const [key, value] of [['AIFY_ACTIVITY_SESSION_BYTES', '0'], ['AIFY_ACTIVITY_MAX_SESSIONS', '17'], ['AIFY_ACTIVITY_MAX_AGE_MS', '86400001']]) {
    assert.throws(() => activityConfiguration({ AIFY_FILE_ACTIVITY: '1', [key]: value }));
  }
  const { run, dir } = fixture({ AIFY_FILE_ACTIVITY: '0' });
  assert.equal(run(input).status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'probe', 'activity-v2')), false);
});

export { input, identity, fixture };
