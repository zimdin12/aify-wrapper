// Test-only dashboard source adapter. No server entry, live endpoint, native runtime or global profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SOURCES = ['server/src/bridge/wsl-facts.ts', 'server/src/locations/wsl.ts', 'server/src/locations/normalize.ts',
  'server/src/routes/register.ts', 'server/src/routes/turn-start.ts', 'server/src/app.ts', 'server/src/config.ts',
  'server/src/build-stamp.ts', 'server/src/store/open.ts'];
const hashes = files => files.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const head = repo => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

export class DashboardWslContract {
  constructor({ repo, commit, files, before, collector, parser, appModules }) {
    Object.assign(this, { repo, commit, files, before, collector, parser, appModules });
  }
  static async open({ testFile, withApp = false }) {
    const repo = process.env.AIFY_DASHBOARD_REPO;
    assert.ok(repo && fs.existsSync(path.join(repo, SOURCES[0])), 'NOT_RUN: mandatory AIFY_DASHBOARD_REPO source checkout missing/unreadable');
    let commit, before, modules;
    const own = [fileURLToPath(import.meta.url), fileURLToPath(testFile), fileURLToPath(new URL('./fixtures/wsl-facts.json', import.meta.url))];
    const files = [...SOURCES.map(file => path.join(repo, file)), ...own];
    try {
      commit = head(repo); before = hashes(files);
      const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', 'server/src', 'package.json'], { encoding: 'utf8' });
      assert.equal(dirty, '', 'dashboard source checkout must be clean for commit-qualified comparison');
      const load = file => import(pathToFileURL(path.join(repo, file)).href);
      const [collector, parser, ...appModules] = await Promise.all([
        load(SOURCES[0]), load('server/src/routes/register.ts'),
        ...(withApp ? ['server/src/app.ts', 'server/src/config.ts', 'server/src/build-stamp.ts', 'server/src/store/open.ts'].map(load) : []),
      ]);
      modules = { collector: collector.collectWslFacts, parser: parser.wslFacts, appModules };
    } catch (error) { assert.fail(`NOT_RUN: dashboard source/runtime prerequisite refused: ${error.stack || error}`); }
    console.log('DASHBOARD_WSL_CONTRACT_INPUTS', JSON.stringify({ commit, node: process.version, sources: before }));
    return new DashboardWslContract({ repo, commit, files, before, ...modules });
  }
  assertUnchanged() {
    assert.equal(head(this.repo), this.commit, 'dashboard commit changed during comparison');
    assert.deepEqual(hashes(this.files), this.before, 'named dashboard/driver/specimen inputs changed during comparison');
  }
}

export const specimens = JSON.parse(fs.readFileSync(new URL('./fixtures/wsl-facts.json', import.meta.url), 'utf8'));
