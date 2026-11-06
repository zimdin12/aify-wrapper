// New coverage: wrapper↔dashboard rule drift and native platform omission, not a second dashboard-only parser test.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { collectWslFacts, WslFactsReader } from '../lib/wsl-facts.mjs';
import { DashboardWslContract, specimens } from './dashboard-wsl-contract.mjs';

let dashboard;
before(async () => { dashboard = await DashboardWslContract.open({ testFile: import.meta.url }); });
after(() => dashboard?.assertUnchanged());
for (const specimen of specimens.filter(row => row.platform === 'linux')) test(`collectWslFacts twin: ${specimen.name}`, () => {
  const read = file => specimen.files[file] ?? null;
  assert.deepEqual(dashboard.collector(read), specimen.expected, 'dashboard authority differs from the frozen specimen');
  assert.deepEqual(collectWslFacts(read), specimen.expected, 'wrapper differs from literal expected facts');
  const parsed = specimen.expected && (specimen.expected.distroId !== null || specimen.expected.driveMounts.length) ? specimen.expected : null;
  assert.deepEqual(dashboard.parser({ wsl: collectWslFacts(read) }), parsed, 'actual registration parser disagrees with expected wire evidence');
});
for (const specimen of specimens) test(`WslFactsReader: ${specimen.name}`, async () => {
  const reads = [];
  const reader = new WslFactsReader({ platform: specimen.platform, readFile: async file => {
    reads.push(file);
    if (!(file in specimen.files)) throw Object.assign(new Error('owned unreadable proc fixture'), { code: 'ENOENT' });
    return specimen.files[file];
  } });
  let actual;
  await assert.doesNotReject(async () => { actual = await reader.read(); }, 'unreadable proc inputs must narrow evidence without throwing');
  assert.deepEqual(actual, specimen.expected);
  if (specimen.platform !== 'linux') assert.deepEqual(reads, [], 'non-Linux publisher touched proc');
});
