// Runtime-bound focused qualification. The maintained npm runner still owns discovery and fixture teardown.
// Usage: <absolute-node> docs/evidence/activity-6/qualify.mjs <unique-label> [test files...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const label = process.argv[2];
if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('unique label required');
const output = path.join(ROOT, '.check-output/activity-6', label); fs.mkdirSync(output);
const home = path.join(output, 'home'); fs.mkdirSync(home);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_)/i.test(k)
  && !/^(NODE_OPTIONS|HERMES_SESSION_ID|HOME|USERPROFILE|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|HERMES_HOME|PATH)$/i.test(k)));
for (const key of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'HERMES_HOME']) env[key] = home;
env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
env.npm_config_update_notifier = 'false';
const systemRoot = Object.entries(env).find(([k]) => k.toUpperCase() === 'SYSTEMROOT')?.[1];
const shell = process.platform === 'win32' ? path.join(systemRoot, 'System32/cmd.exe') : '/bin/sh';
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
if (!fs.existsSync(npm)) throw new Error('set npm_execpath to the matching npm-cli.js');
const probe = path.join(output, 'worker-probe.mjs'), workers = path.join(output, 'workers.jsonl');
fs.writeFileSync(probe, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(workers)},JSON.stringify({node:process.version,executable:process.execPath,argv:process.argv})+'\\n');\n`, { flag: 'wx' });
env.NODE_OPTIONS = '--import=' + pathToFileURL(probe).href;
const hash = b => createHash('sha256').update(b).digest('hex');
const files = process.argv.slice(3);
if (!files.length) files.push('tests/file-activity.test.js', 'tests/activity-spool.test.js', 'tests/activity-launcher.test.js', 'tests/herdr-tool-parity.test.js', 'tests/file-activity-capability.test.js');
const sourcePaths = [...new Set([...files, 'bin/aify-tool-event.mjs', 'lib/file-activity.mjs', 'lib/activity-spool.mjs', 'lib/activity-storage.mjs', 'lib/herdr-tool-state.mjs', 'wrappers/claude-aify.sh.in', 'lib/registry.mjs', 'lib/service-spec.mjs', 'bin/aify-herdr-state.sh', 'lib/codex-herdr-hooks.mjs', 'tests/run-in-a-temp-root.mjs', 'docs/evidence/activity-6/qualify.mjs'])];
const bindings = () => Object.fromEntries(sourcePaths.map(p => [p, hash(fs.readFileSync(path.join(ROOT, p)))]));
const before = bindings();
const lookup = process.platform === 'win32' ? spawnSync(shell, ['/d', '/c', 'node --version'], { env, encoding: 'utf8' }) : spawnSync('/bin/sh', ['-c', 'node --version'], { env, encoding: 'utf8' });
if (lookup.status !== 0 || lookup.stdout.trim() !== process.version) throw new Error('PATH did not select the admitted runtime');
const command = [process.execPath, npm, '--script-shell=' + shell, 'test', '--', ...files];
const run = spawnSync(command[0], command.slice(1), { cwd: ROOT, env, encoding: 'utf8', timeout: 240000, maxBuffer: 10 * 1024 * 1024 });
const raw = (run.stdout || '') + (run.stderr || ''); fs.writeFileSync(path.join(output, 'raw.txt'), raw, { flag: 'wx' });
const observed = fs.readFileSync(workers, 'utf8').trim().split('\n').map(JSON.parse);
const selectedWorkers = observed.filter(r => files.some(f => path.resolve(r.argv[1] || '').toLowerCase() === path.resolve(ROOT, f).toLowerCase()));
const after = bindings();
const receipt = { node: process.version, executable: process.execPath, executableSha256: hash(fs.readFileSync(process.execPath)), command,
  exit: run.status, signal: run.signal, pathProbe: lookup.stdout.trim(), source: before, sourceAfter: after,
  raw: 'raw.txt', sha256: hash(raw), workers: selectedWorkers,
  total: Number(/(?:#|ℹ) tests (\d+)/.exec(raw)?.[1] || 0),
  pass: Number(/(?:#|ℹ) pass (\d+)/.exec(raw)?.[1] || 0), fail: Number(/(?:#|ℹ) fail (\d+)/.exec(raw)?.[1] || 0),
  skipped: Number(/(?:#|ℹ) skipped (\d+)/.exec(raw)?.[1] || 0) };
fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, exit: run.status, total: receipt.total, pass: receipt.pass, fail: receipt.fail, skipped: receipt.skipped, workers: selectedWorkers.length }));
if (JSON.stringify(before) !== JSON.stringify(after) || selectedWorkers.length !== files.length || selectedWorkers.some(r => r.node !== process.version || r.executable.toLowerCase() !== process.execPath.toLowerCase())) throw new Error('source or worker runtime binding failed');
if (!receipt.total || run.status !== 0) process.exitCode = 1;
