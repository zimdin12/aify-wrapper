// New coverage: the actual publisher body reaches dashboard's real router/store/resolver, not a handwritten parser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { DashboardWslContract, specimens } from './dashboard-wsl-contract.mjs';
import { host, KEY, service } from './turn-start-host.mjs';

const RUNNER = fileURLToPath(new URL('../bin/aify-turn-start.mjs', import.meta.url));
const DISTRO = '0f3c9a7e5b2d4c6e8a1b3d5f7e9c2a4b';
const PRELOAD = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const specimen=JSON.parse(process.env.WSL_PROBE_INPUT);
const sync=fs.readFileSync.bind(fs),asyncRead=fs.promises.readFile.bind(fs.promises);
const owned=file=>typeof file==='string' && (file.startsWith('/proc/') || file==='/etc/machine-id');
const answer=file=>{if(!(file in specimen.files))throw Object.assign(new Error('owned unreadable proc'),{code:'ENOENT'});return specimen.files[file];};
fs.readFileSync=(file,...rest)=>owned(file)?answer(file):sync(file,...rest);
fs.promises.readFile=async(file,...rest)=>owned(file)?answer(file):asyncRead(file,...rest);
Object.defineProperty(process,'platform',{value:specimen.platform});syncBuiltinESMExports();
`;
let dashboard;
before(async () => { dashboard = await DashboardWslContract.open({ testFile: import.meta.url, withApp: true }); });
after(() => dashboard?.assertUnchanged());

function appFixture(t) {
  const [{ buildApp }, { loadConfig }, { readBuildStamp }, { openStore }] = dashboard.appModules;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-private-receiver-'));
  const store = openStore({ path: path.join(root, 'test.db') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = loadConfig({ API_KEY: 'k'.repeat(32), PUBLIC_ORIGINS: 'http://127.0.0.1:9700', DATABASE_PATH: path.join(root, 'test.db'), UI_ROOT: path.join(root, 'ui') });
  const app = buildApp({ config, uiRoot: config.uiRoot, store, stamp: readBuildStamp({}), now: () => 1800000000000, startedAt: 0 });
  const drive = app.projects.register({ root: { raw: 'C:/Docker/turned', canonical: 'C:/Docker/turned', machineId: 'win32:host-a' }, name: 'On the drive' }, 1800000000000);
  const distro = app.projects.register({ root: { raw: '/home/dev/inside', canonical: '/home/dev/inside', machineId: 'wsl:host-a', wsl: { distroId: DISTRO, driveMounts: [] } }, name: 'In the distro' }, 1800000000000);
  assert.ok(drive.ok && distro.ok, 'private project provisioning failed');
  return { app, drive: drive.project.id, distro: distro.project.id };
}
function run(env, input, preload, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, RUNNER], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('owned publisher child exceeded fixture deadline')); }, 7000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}
const selected = [
  ['Windows planted Microsoft release must not publish', 'C:/Docker/turned/src', 'drive'],
  ['plain Linux ignores misleading WSL environment', '/home/native/src', null],
  ['unreadable osrelease is not evidence', '/home/native/src', null],
  ['standard WSL mount', '/mnt/c/Docker/turned/src', 'drive'],
  ['empty WSL evidence stays explicit', '/mnt/c/Docker/turned/src', null],
  ['blank identity with good mount still places a drive', '/mnt/c/Docker/turned/src', 'drive'],
  ['nonstandard mount is declared not guessed', '/mnt/host/c/Docker/turned/src', 'drive'],
  ['escaped mount survives to placement', '/mnt/my drive/Docker/turned/src', 'drive'],
  ['identity is trimmed and unreadable mounts stay empty', '/home/dev/inside/src', 'distro'],
];
for (const [name, cwd, project] of selected) test(`WSL publisher→receiver: ${name}`, async t => {
  const specimen = specimens.find(row => row.name === name); assert.ok(specimen);
  const f = appFixture(t), replies = [];
  const svc = await service(t, (request, response, raw) => {
    assert.equal(request.headers['x-api-key'], KEY);
    const match = f.app.router.match('POST', '/events/turn-start'); assert.equal(match.kind, 'found');
    const reply = match.match.route.handler({ params: {}, query: new URLSearchParams(), body: JSON.parse(raw),
      principal: { kind: 'agent', claimedAgentId: 'probe-agent' }, headers: {}, method: 'POST', path: '/events/turn-start' });
    replies.push(reply); response.writeHead(reply.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply.body));
  });
  const env = host(t, { endpoint: svc.endpoint, env: { AIFY_MACHINE_ID: 'host-a', WSL_PROBE_INPUT: JSON.stringify(specimen), ...specimen.env } });
  const preload = path.join(env.HOME, 'owned-proc-preload.mjs'); fs.writeFileSync(preload, PRELOAD);
  const result = await run(env, { hook_event_name: 'SessionStart', session_id: `fixture-${selected.findIndex(row => row[0] === name)}`, cwd }, preload, env.HOME);
  assert.equal(result.status, 0, result.stderr); assert.equal(svc.seen.length, 1, 'publisher never reached the owned receiver');
  assert.equal(replies[0].status, 200); assert.equal(replies[0].body.projectId, project === null ? null : f[project], 'facts did not survive to actual receiver placement');
  if (project !== null) assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, new RegExp(project === 'drive' ? 'On the drive' : 'In the distro'), 'placed receiver text did not reach the actual hook output');
  const body = svc.seen[0].body;
  if (specimen.expected === null) assert.equal(Object.hasOwn(body, 'wsl'), false, 'non-WSL publisher emitted a placement claim');
  else assert.deepEqual(body.wsl, specimen.expected);
  assert.equal(body.cwd, cwd); assert.equal(body.agentId, 'probe-agent'); assert.equal(body.moment, 'start');
  assert.equal(body.machineId, `${specimen.platform === 'win32' ? 'win32' : specimen.expected === null ? 'linux' : 'wsl'}:host-a`);
});
