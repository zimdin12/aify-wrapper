// Native sink parity against the unchanged predecessor shell, not two paths sharing a new rule.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { herdrToolReport, reportToolWorking } from '../lib/herdr-tool-state.mjs';
console.log(JSON.stringify({ worker: 'herdr-tool-parity', node: process.version, executable: process.execPath }));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = [
  ['private first', { AIFY_HERDR_PANE_ID: 'wA:pB', HERDR_PANE_ID: 'w2:p3' }],
  ['empty private fallback', { AIFY_HERDR_PANE_ID: '', HERDR_PANE_ID: 'w2:p3' }],
  ['missing pane file exclusive', { AIFY_HERDR_PANE_FILE: 'missing', HERDR_PANE_ID: 'w2:p3' }],
  ['first line', { AIFY_HERDR_PANE_FILE: 'file' }, 'wA:pB\nw2:p3\n'],
  ['CR is not trimmed by shell', { AIFY_HERDR_PANE_FILE: 'file' }, 'wA:pB\r\n'],
  ['unknown target', { AIFY_HERDR_PANE_ID: 'w1:p2:bad' }],
  ['nonempty non-claim label', { AIFY_HERDR_AGENT: 'legacy label !' }],
  ['empty agent', { AIFY_HERDR_AGENT: '' }],
  ['comma fraction', { AIFY_HOOK_FIRED_AT: '1790000000,5' }],
  ['dot fraction', { AIFY_HOOK_FIRED_AT: '1790000000.12345678' }],
  ['integer explicit', { AIFY_HOOK_FIRED_AT: '1790000000' }],
  ['malformed explicit', { AIFY_HOOK_FIRED_AT: 'x.5' }],
  ['multiple decimal delimiters', { AIFY_HOOK_FIRED_AT: '1790000000.1.2' }],
  ['zero fraction', { AIFY_HOOK_FIRED_AT: '.0' }],
];
for (const [name, extra, contents] of cases) test(`combined working preserves predecessor: ${name}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity parity '));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(k)));
  for (const k of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'HERMES_HOME']) env[k] = dir;
  Object.assign(env, { HERDR_BIN_PATH: process.execPath, AIFY_HERDR_AGENT: 'legacy label !', AIFY_HERDR_PANE_ID: 'wA:pB', AIFY_HOOK_FIRED_AT: '1790000000.5', AIFY_FILE_ACTIVITY: '0' }, extra);
  if (extra.AIFY_HERDR_PANE_FILE) env.AIFY_HERDR_PANE_FILE = path.join(dir, extra.AIFY_HERDR_PANE_FILE);
  if (contents !== undefined) fs.writeFileSync(env.AIFY_HERDR_PANE_FILE, contents);
  const preload = path.join(dir, 'sink.mjs'), log = path.join(dir, 'calls');
  fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';if(path.basename(process.argv[1]||'')==='pane'){fs.appendFileSync(process.env.PRIVATE_SINK,JSON.stringify(['pane',...process.argv.slice(2)])+'\\n');process.exit(0)}`);
  Object.assign(env, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, PRIVATE_SINK: log });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const old = spawnSync('sh', [path.join(ROOT, 'bin/aify-herdr-state.sh').replaceAll('\\', '/'), 'working'], { env, input: '{}', encoding: 'utf8' });
  assert.equal(old.status, 0); assert.equal(old.stdout + old.stderr, ''); const expected = calls();
  // The report itself, not its delivery: reportToolWorking gives herdr 4000 ms (it was 1500), and this fake herdr is a node start,
  // which a loaded host took 3.4 s to make, so a spawned comparison read a missed deadline as divergence.
  // bin/aify-tool-event.mjs hands this function process.env; activity-launcher.test.js holds the delivery.
  const report = herdrToolReport({ env, firedAt: Date.now() });
  if (report) assert.equal(report.command, env.HERDR_BIN_PATH);
  assert.deepEqual(report ? [report.args] : [], expected, 'combined state diverged from frozen shell');
});
test('millisecond fallback outranks an earlier launch claim and names the existing source', () => {
  const report = herdrToolReport({ env: { AIFY_HERDR_AGENT: 'legacy label', AIFY_HERDR_PANE_ID: 'wA:pB' }, firedAt: 1790000000123 });
  assert.equal(report.args.at(-1), '1790000000123000');
  assert.ok(report.args.includes('herdr:aify'));
  assert.doesNotThrow(() => reportToolWorking({ env: {}, firedAt: 1 }));
});
