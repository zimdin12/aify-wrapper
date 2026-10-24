// Service-spec admission is a separate guard from local opt-in. Existing registry tests know no activity field.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegistry } from '../lib/registry.mjs';
import { validateSpec } from '../lib/service-spec.mjs';
const parse = capability => parseRegistry(JSON.stringify({ version: 1, services: { dashboard: { endpoint: 'http://127.0.0.2:1', ...(capability === undefined ? {} : { fileActivity: capability }) } } }));
test('absent capability stays absent; explicit fixed route survives registry and spec admission', () => {
  assert.equal(parse().registry.services.dashboard.fileActivity, undefined);
  const capability = { path: '/api/v1/file-activity' };
  assert.deepEqual(parse(capability).registry.services.dashboard.fileActivity, capability, 'activity capability was silently discarded');
  const spec = { specVersion: 1, name: 'dashboard', fixed: { fileActivity: capability }, artifacts: [], mcp: [], secrets: [], verify: { health: { path: '/health' }, probes: {} } };
  const judged = validateSpec(spec, { name: 'dashboard', endpoint: 'http://127.0.0.2:1' });
  assert.equal(judged.ok, true, judged.errors.join('; '));
});
for (const [name, capability] of [['null', null], ['foreign route', { path: '//outside.example/activity' }], ['unknown option', { path: '/api/v1/file-activity', credentialRef: 'invented.key' }], ['missing path', {}]])
  test(`activity registry refuses ${name} without guessing a capability`, () => assert.equal(parse(capability).ok, false));
