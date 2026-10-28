// This exercises the emitted command, not template spelling. The old suite has no native Windows sink.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

console.log(JSON.stringify({ worker: 'activity-launcher', node: process.version, executable: process.execPath }));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const bash = spawnSync(WIN ? 'bash' : 'sh', ['-c', WIN ? 'cygpath -w "$(command -v bash)"' : 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
const native = p => p.replaceAll('\\', '/');
const shellPath = p => WIN ? spawnSync(bash, ['-c', 'cygpath -u "$1"', '_', p], { encoding: 'utf8' }).stdout.trim() : p;
const body = { session_id: 'real-input-session', cwd: 'C:/owned project', tool_name: 'Read', tool_use_id: 'call-1', tool_input: { file_path: 'file.txt', contents: 'SECRET-CONTENT' } };
function fixture({ enabled = '1', managed = false, claimed = false, rewrite = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity native space '));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(k)));
  for (const k of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'HERMES_HOME']) env[k] = dir;
  const out = path.join(dir, 'out'), bridge = path.join(dir, 'bridge'), wrapper = path.join(dir, 'wrapper with spaces'), stubs = path.join(dir, 'stubs');
  for (const d of [out, bridge, wrapper, stubs]) fs.mkdirSync(d);
  for (const file of ['bin/aify-tool-event.mjs', 'bin/aify-tool-hook-json.sh', 'bin/aify-herdr-state.sh', 'bin/aify-herdr-pane.mjs', 'bin/aify-herdr-launch.sh', ...fs.readdirSync(path.join(ROOT, 'lib')).filter(n => n.endsWith('.mjs')).map(n => `lib/${n}`)]) {
    const to = path.join(wrapper, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ROOT, file), to);
  }
  const registry = path.join(dir, 'registry'); fs.writeFileSync(registry, '');
  const channel = path.join(bridge, 'claude-channel.js'); fs.writeFileSync(channel, '// owned installed channel specimen\n');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'aify-comms-channel': { command: 'node', args: [channel] } } }));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(path.join(stubs, 'claude'), `#!/bin/bash\nenv > "${native(settings)}.env"\nwhile [ $# -gt 0 ]; do if [ "$1" = --settings ]; then cp "$2" "${native(settings)}"; fi; shift; done\n`, { mode: 0o755 });
  env.PATH = [stubs, path.dirname(process.execPath), path.dirname(bash)].join(path.delimiter);
  Object.assign(env, { AIFY_FILE_ACTIVITY: enabled, AIFY_ENV_INSTANCE: 'fixture-instance', AIFY_AGENT_LEASE_DIR: path.join(dir, 'state'), MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });
  if (rewrite) { delete env.MSYS_NO_PATHCONV; delete env.MSYS2_ARG_CONV_EXCL; }
  if (managed) env.AIFY_HERDR_PANE_FILE = path.join(dir, 'pane');
  const trace = path.join(dir, 'trace'), preload = path.join(dir, 'private-native-sink.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs'; fs.appendFileSync(process.env.ACTIVITY_TRACE,JSON.stringify({exe:process.execPath,version:process.version,args:process.argv.slice(1)})+'\\n');`);
  // Herdr is bash running `pane` from PATH, not node: the working report gives herdr 4000 ms (it was 1500), and a node start with this
  // preload took up to 3.4 s on a loaded host, which read as a missing report. The script uses only builtins.
  fs.writeFileSync(path.join(stubs, 'pane'), `printf '{"exe":"herdr","args":["pane","%s"]}\\n' "$1" >> "$ACTIVITY_TRACE"\nif [ "$1" = list ]; then printf '%s' '{"result":{"panes":[{"pane_id":"wA:pB","terminal_id":"owned-terminal"}]}}'; fi\n`);
  Object.assign(env, { HERDR_BIN_PATH: bash, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ACTIVITY_TRACE: trace });
  if (claimed) Object.assign(env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wA:pB', HERDR_WORKSPACE_ID: 'wA' });
  const rendered = spawnSync(bash, [native(path.join(ROOT, 'install.sh')), '--client', 'claude', '--endpoint', 'http://127.0.0.2:1', '--registry', native(registry), '--render-only', native(out), '--bridge-dir', shellPath(bridge), '--wrapper-dir', shellPath(wrapper)], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  const started = spawnSync(bash, [native(path.join(out, 'claude-aify')), '--aify-agent', 'probe', '--aify-ignore-definition'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const config = JSON.parse(fs.readFileSync(settings));
  const runtime = Object.fromEntries(fs.readFileSync(settings + '.env', 'utf8').trim().split(/\r?\n/).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  fs.writeFileSync(trace, '');
  Object.assign(env, { AIFY_AGENT_ID: runtime.AIFY_AGENT_ID, AIFY_HERDR_AGENT: runtime.AIFY_HERDR_AGENT || '', AIFY_HOOK_FIRED_AT: '1790000000,5' });
  if (claimed) { env.AIFY_HERDR_PANE_ID = runtime.AIFY_HERDR_PANE_ID; env.HERDR_PANE_ID = runtime.HERDR_PANE_ID || ''; }
  const fire = (event, input = body, overrides = {}) => {
    const hooks = config.hooks[event]?.flatMap(g => g.hooks) || [];
    const results = hooks.map(h => spawnSync(bash, ['-c', h.command], { env: { ...env, ...overrides }, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000 }));
    for (const result of results) { assert.equal(result.status, 0, `status ${result.status} signal ${result.signal} error ${result.error?.code ?? result.error}\n${result.stderr}`); assert.equal(result.stdout + result.stderr, '', 'hook is not silent'); }
    return hooks;
  };
  const calls = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const spool = () => {
    const directory = path.join(env.AIFY_AGENT_LEASE_DIR, 'probe/activity-v2');
    const records = fs.readdirSync(directory).filter(n => n.endsWith('.jsonl'))
      .flatMap(n => fs.readFileSync(path.join(directory, n), 'utf8').trimEnd().split('\n').map(JSON.parse));
    return { records };
  };
  return { dir, config, env, runtime, fire, calls, spool };
}
for (const rewrite of [false, true]) test(`activity enabled without Herdr executes one native hook per outcome, argv conversion ${rewrite}`, () => {
  const f = fixture({ rewrite });
  // Three since the turn-start runner joined SessionStart for the dashboard's brief; the lifetime report is named, not counted.
  const starting = f.config.hooks.SessionStart[0].hooks.map((hook) => hook.command);
  assert.ok(starting.some((command) => command.includes('resident-started')), 'resident-started SessionStart lost');
  assert.equal(starting.length, 3, `SessionStart runs ${starting.length} commands`);
  for (const event of ['PostToolUse', 'PostToolUseFailure']) assert.equal(f.fire(event).length, 1, 'parallel observer or missing combined hook');
  const batch = f.spool();
  assert.deepEqual(batch.records.map(e => e.record.event.outcome), ['success', 'failure']);
  assert.equal(JSON.stringify(batch.records).includes('SECRET'), false, 'raw payload persisted');
  const calls = f.calls(); assert.equal(calls.length, 2, 'second parser process started');
  for (const c of calls) { assert.equal(c.exe.toLowerCase(), process.execPath.toLowerCase()); assert.equal(c.version, process.version, 'hook selected a different runtime'); }
});
test('cap off retains no outside-Herdr tool hooks and managed legacy working reports', () => {
  assert.equal(fixture({ enabled: '0' }).config.hooks.PostToolUse, undefined);
  const f = fixture({ enabled: '0', managed: true }); fs.writeFileSync(f.env.AIFY_HERDR_PANE_FILE, 'wA:pB\n');
  assert.equal(f.fire('PostToolUse', '{}').length, 1);
  assert.equal(f.calls().filter(c => path.basename(c.args[0]) === 'pane').length, 1);
  assert.equal(fs.existsSync(path.join(f.env.AIFY_AGENT_LEASE_DIR, 'probe/activity-v2')), false);
});
// Distinct independence directions, neither is covered by an extractor unit test.
test('malformed input, disabled config, unsupported tool, missing identity and storage failure cannot suppress working', () => {
  const f = fixture({ managed: true }); fs.writeFileSync(f.env.AIFY_HERDR_PANE_FILE, 'wA:pB\n');
  for (const [input, extra] of [['{bad', {}], [body, { AIFY_FILE_ACTIVITY: 'bad' }], [{ ...body, tool_name: 'Bash' }, {}], [body, { AIFY_AGENT_ID: '' }], [body, { AIFY_AGENT_LEASE_DIR: path.join(f.dir, 'not-directory') }]]) {
    fs.writeFileSync(path.join(f.dir, 'not-directory'), 'owned'); f.fire('PostToolUse', input, extra);
  }
  assert.equal(f.calls().filter(c => path.basename(c.args[0]) === 'pane').length, 5, 'activity failure suppressed existing working report');
});
test('missing and refused Herdr targets cannot suppress valid activity', () => {
  const f = fixture({ managed: true }); f.fire('PostToolUse');
  fs.writeFileSync(f.env.AIFY_HERDR_PANE_FILE, 'not a pane\n'); f.fire('PostToolUseFailure');
  assert.equal(f.spool().records.length, 2, 'missing/refused Herdr suppressed activity');
  assert.equal(f.calls().filter(c => path.basename(c.args[0]) === 'pane').length, 0);
});
for (const enabled of ['0', '1']) test(`actual native pane claim preserves one working command per tool, activity ${enabled}`, () => {
  const f = fixture({ enabled, claimed: true });
  assert.equal(f.runtime.AIFY_HERDR_PANE_ID, 'wA:pB', 'real claim never reached its private-target handoff');
  assert.equal(f.runtime.HERDR_PANE_ID, undefined, 'native resume target leaked back into the claimed agent');
  for (const event of ['PostToolUse', 'PostToolUseFailure']) assert.equal(f.fire(event).length, 1);
  assert.equal(f.calls().filter(c => path.basename(c.args[0]) === 'pane').length, 2, 'combined working reports missing');
  if (enabled === '1') { assert.equal(f.spool().records.length, 2); assert.equal(f.calls().length, 4, 'parallel parser child started'); }
  else assert.equal(fs.existsSync(path.join(f.env.AIFY_AGENT_LEASE_DIR, 'probe/activity-v2')), false);
});
