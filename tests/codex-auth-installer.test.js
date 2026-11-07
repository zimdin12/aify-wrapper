// The new lib/ prerequisite must refuse before Node/registry reads or replacing an existing launcher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {readerWrapper} from './definition-reader-wrapper.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const posix = value => value.replaceAll('\\', '/');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('Codex auth helper prerequisite preserves the installed target, with healthy install and render-only controls', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-install-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home'), dest = path.join(root, 'dest'), bridge = path.join(root, 'bridge');
  for (const dir of [home, dest, bridge]) fs.mkdirSync(dir);
  const wrapper = readerWrapper(path.join(root, 'wrapper'));
  const registry = path.join(root, 'services.json'), target = path.join(dest, 'codex-aify');
  fs.writeFileSync(registry, '');
  const env = {...process.env, HOME: home, USERPROFILE: home, AIFY_NO_PROMPT: '1'};
  const args = [path.join(ROOT, 'install.sh'), '--client', 'codex', '--endpoint', 'http://127.0.0.2:1',
    '--wrapper-dir', posix(wrapper), '--bridge-dir', posix(bridge), '--registry', posix(registry), '--dest', posix(dest)];
  const run = (extra = [], extraEnv = {}) => spawnSync('bash', [...args, ...extra], {env: {...env, ...extraEnv}, encoding: 'utf8', timeout: 60000});
  const healthy = run();
  assert.equal(healthy.status, 0, healthy.stderr);
  const before = fs.readFileSync(target);
  assert.ok(before.includes('codex-app-server-auth.mjs'));
  const records = path.join(root, 'launchers'), names = fs.readdirSync(records);
  assert.equal(names.length, 1, 'healthy install must do real record/launcher work');
  const record = path.join(records, names[0]), recordBefore = fs.readFileSync(record);
  assert.match(names[0], /^[0-9a-f]{24}\.args$/);

  const stubs = path.join(root, 'stubs');fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'node'), '#!/bin/bash\nprintf called > "$AUTH_HELPER_TRIPWIRE"\nexit 91\n', {mode: 0o755});
  const PATH = stubs + path.delimiter + env.PATH, positive = path.join(root, 'positive'), marker = path.join(root, 'unexpected');
  const control = spawnSync('bash', ['-c', 'node'], {env: {...env, PATH, AUTH_HELPER_TRIPWIRE: posix(positive)}, encoding: 'utf8'});
  assert.equal(control.status, 91, control.stderr);
  assert.equal(fs.readFileSync(positive, 'utf8'), 'called');
  assert.equal(fs.existsSync(marker), false);
  fs.unlinkSync(path.join(wrapper, 'lib/codex-app-server-auth.mjs'));
  const rejected = run([], {PATH, AUTH_HELPER_TRIPWIRE: posix(marker)});
  assert.deepEqual({status: rejected.status, named: rejected.stderr.includes('has no lib/codex-app-server-auth.mjs'),
    nodeCalled: fs.existsSync(marker), targetSha256: sha(fs.readFileSync(target)), recordSha256: sha(fs.readFileSync(record))},
  {status: 78, named: true, nodeCalled: false, targetSha256: sha(before), recordSha256: sha(recordBefore)}, 'auth prerequisite refuses before Node or installed-byte mutation');

  const rendered = path.join(root, 'rendered'), renderOnly = run(['--render-only', posix(rendered)]);
  assert.equal(renderOnly.status, 0, renderOnly.stderr);
  assert.equal(fs.existsSync(path.join(rendered, 'codex-aify')), true);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.deepEqual(fs.readFileSync(record), recordBefore);
});
