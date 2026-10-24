// Unit reporting and real Bash/helper/writer boundaries, not a full launcher or native runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLease } from '../bin/aify-agent-lease.mjs';
import { LeaseBusyError } from '../lib/agent-lease.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'tests/test-data/resident-start-fixture.mjs').replaceAll('\\', '/');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const q = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const native = value => value.replaceAll('\\', '/');
const capture = { agentId: 'task8-agent', intent: 'replace', harness: 'claude', producer: 'SessionStart',
  storeId: 'owned-store', incarnation: 1, revision: 2, stopRevision: 0, stopReceipt: 'a'.repeat(64) };
const claimArgs = ['claim', '--agent', 'task8-agent', '--pid', '123', '--mode', 'resident', '--identity', 'flag'];
function report(extra = [], { env = {}, decision = 'claim', error, watchError = false, reporting = true } = {}) {
  let stdout = '', stderr = '', claimed, watches = 0;
  const status = runLease([...claimArgs, ...extra, ...(reporting ? ['--report', 'resident-start'] : [])], {
    env, out: { write: text => { stdout += text; } }, err: { write: text => { stderr += text; } },
    lease: () => ({ claim: args => { claimed = args; if (error) throw error; return { decision, stopped: [], live: { pid: 17 } }; } }),
    watch: () => { watches++; if (watchError) throw new Error('owned watch failure'); },
  });
  return { status, stdout, stderr, claimed, watches };
}
for (const [name, args, env, expected] of [
  ['inferred named resident replace', [], {}, 'replace'],
  ['explicit resident replace', ['--intent', 'replace'], {}, 'replace'],
  ['explicit start', ['--intent', 'start'], {}, 'none'],
  ['invalid intent resolves to start', ['--intent', 'typo'], {}, 'none'],
  ['managed even with explicit replace', ['--mode', 'managed', '--intent', 'replace'], {}, 'none'],
  ['recovered even with explicit replace', ['--identity', 'recovered', '--intent', 'replace'], {}, 'none'],
  ['remembered inside session', ['--inside', '1', '--intent', 'replace'], {}, 'none'],
  ['inherited native marker', ['--intent', 'replace'], { CLAUDE_CODE_CHILD_SESSION: '1' }, 'none'],
  ['inherited lease marker', ['--intent', 'replace'], { AIFY_AGENT_LEASE: '789' }, 'none'],
]) test(`accepted claim report: ${name}`, () => {
  const result = report(args, { env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.claimed, 'actual claim collaborator reached');
  assert.equal(result.stdout, `${expected}\n`);
  assert.equal(result.watches, 1);
});
test('default stdout stays empty and a failed watch does not revoke an accepted claim', () => {
  assert.equal(report([], { reporting: false }).stdout, '');
  const result = report([], { watchError: true });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'replace\n');
  assert.match(result.stderr, /could not start the watch/);
});
for (const [name, options, status] of [
  ['refused', { decision: 'refuse' }, 75], ['nested', { decision: 'nested' }, 75],
  ['busy', { error: new LeaseBusyError('owned busy') }, 75], ['failed', { error: new Error('owned failure') }, 70],
]) test(`unsuccessful ${name} claim grants no report`, () => {
  const result = report([], options);
  assert.equal(result.status, status, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.watches, 0);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'task8-wrapper-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  for (const name of ['aify-lease.sh', 'aify-lifetime.sh', 'aify-agent-lease.mjs', 'aify-resident-record.mjs'])
    fs.copyFileSync(path.join(ROOT, 'bin', name), path.join(bin, name));
  // Allowlisted OS execution inputs only. No AIFY/HARNESS/HERDR/session inheritance or live roots.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, HERMES_HOME: path.join(home, '.hermes'),
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    TMPDIR: home, TEMP: home, TMP: home, TEMPDIR: home,
    TASK8_NODE: native(process.execPath), TASK8_HELPER: HELPER, TASK8_EVENTS: path.join(home, 'events'),
    TASK8_CAPTURE: JSON.stringify(capture) });
  for (const name of ['HERMES_HOME', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[name], { recursive: true });
  const bashName = process.platform === 'win32' ? 'bash.exe' : 'bash';
  const bash = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, bashName)).find(file => fs.existsSync(file));
  assert.ok(bash, 'explicit native Bash executable required');
  const prelude = `set -euo pipefail
. ${q(native(path.join(bin, 'aify-lease.sh')))}
node() {
  case "$1" in
    */aify-agent-lease.mjs) command "$TASK8_NODE" "$TASK8_HELPER" claim "$@" ;;
    */aify-resident-record.mjs) command "$TASK8_NODE" "$@" ;;
    *) echo 'unexpected node call' >&2; return 99 ;;
  esac
}
aify-env() { command "$TASK8_NODE" "$TASK8_HELPER" capture "$@"; }
`;
  function run(body, extra = {}) {
    const script = path.join(home, 'owned.sh'); fs.writeFileSync(script, prelude + body);
    const result = spawnSync(bash, ['--noprofile', '--norc', native(script)], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.signal, null, `fixture execution interrupted: ${result.stderr}`);
    return result;
  }
  return { home, bin, env, bash, run };
}
const snapshot = 'MSYS_NO_PATHCONV=1 command "$TASK8_NODE" "$TASK8_HELPER" snapshot\n';
const named = 'aify_lease_take_intent --aify-agent task8-agent\naify_lease_claim task8-agent claude-code resident\n';
test('real shell captures only accepted report, resets each attempt, and never exports permission', t => {
  const f = fixture(t);
  const result = f.run(`export AIFY_LEASE_RESIDENT_START=replace
${named}test "$AIFY_LEASE_RESIDENT_START" = replace
TASK8_DECISION=error; export TASK8_DECISION
aify_lease_claim task8-agent claude-code resident
test -z "$AIFY_LEASE_RESIDENT_START"
test -z "$AIFY_LEASE_AGENT"
unset TASK8_DECISION AIFY_AGENT_LEASE
${named}test "$AIFY_LEASE_RESIDENT_START" = replace
aify_lease_claim '' claude-code resident
test -z "$AIFY_LEASE_RESIDENT_START"
${snapshot}`);
  assert.equal(result.status, 0, result.stderr);
  const { events } = JSON.parse(result.stdout);
  assert.equal(events.filter(row => row.event === 'watch').length, 2);
  for (const row of events.filter(row => row.event === 'claim')) assert.deepEqual(row.args.slice(-2), ['--report', 'resident-start']);
});
for (const [name, statement, held] of [
  ['old helper', "node() { printf ''; return 0; }", true],
  ['partial stdout', "node() { printf 'replace\\nnoise\\n'; return 0; }", true],
  ['failed helper despite replace stdout', "node() { printf 'replace\\n'; return 70; }", false],
  ['refused helper despite replace stdout', "node() { printf 'replace\\n'; return 75; }", false],
  ['missing helper', 'rm "$AIFY_LEASE_BIN/aify-agent-lease.mjs"', false],
  ['missing node', 'command() { if [ "${1:-}" = -v ] && [ "${2:-}" = node ]; then return 1; fi; builtin command "$@"; }', false],
]) test(`shell never grants startup permission for ${name}`, t => {
  const f = fixture(t);
  const result = f.run(`export AIFY_LEASE_RESIDENT_START=replace\n${statement}\n${named.replace('aify_lease_claim task8-agent claude-code resident', 'status=0; aify_lease_claim task8-agent claude-code resident || status=$?')}
test "$status" = ${name.startsWith('refused') ? 75 : 0}
test -z "${'${AIFY_LEASE_RESIDENT_START:-}'}"
${held ? 'test "$AIFY_LEASE_AGENT" = task8-agent' : 'test -z "$AIFY_LEASE_AGENT"'}\n`);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, permission, harness, producer, output, status, expectedCapture, metadata] of [
  ['accepted Claude', 'replace', 'claude', 'SessionStart', JSON.stringify(capture), 0, true, true],
  ['capture refused with otherwise valid stdout', 'replace', 'claude', 'SessionStart', JSON.stringify(capture), 75, true, false],
  ['malformed capture', 'replace', 'claude', 'SessionStart', '{bad', 0, true, false],
  ['no permission', '', 'claude', 'SessionStart', JSON.stringify(capture), 0, false, false],
  ['no declaration', 'replace', 'claude', '', JSON.stringify(capture), 0, false, false],
  ['Codex has no native producer', 'replace', 'codex', '', JSON.stringify(capture), 0, false, false],
  ['Hermes has no native producer', 'replace', 'hermes', '', JSON.stringify(capture), 0, false, false],
]) test(`real lifetime shell and native writer: ${name}`, t => {
  const f = fixture(t);
  const result = f.run(`AIFY_LEASE_RESIDENT_START=${q(permission)}
aify_lifetime_start task8-agent ${q(harness)} resident ${q(producer)}
${snapshot}`, { TASK8_CAPTURE: output, TASK8_CAPTURE_STATUS: String(status) });
  assert.equal(result.status, 0, result.stderr);
  const { records, events } = JSON.parse(result.stdout);
  assert.equal(records.length, 1);
  assert.equal(records[0].harness, harness); assert.equal(records[0].instance, 'residents');
  assert.deepEqual(records[0].operatorStart, metadata ? capture : undefined);
  assert.equal(events.filter(row => row.event === 'capture').length, Number(expectedCapture));
});
test('accepted actual claim feeds pre-record capture and optional metadata through the ninth writer argument', t => {
  const f = fixture(t);
  const result = f.run(`${named}aify_lifetime_start task8-agent claude resident SessionStart\n${snapshot}`);
  assert.equal(result.status, 0, result.stderr);
  const { records, events } = JSON.parse(result.stdout);
  assert.deepEqual(events.map(row => row.event), ['claim', 'watch', 'capture']);
  assert.deepEqual(records[0].operatorStart, capture);
});
test('unavailable capture CLI remains a legacy non-clearing resident', t => {
  const f = fixture(t);
  const result = f.run(`unset -f aify-env
command() { if [ "${'${1:-}'}" = -v ] && [ "${'${2:-}'}" = aify-env ]; then return 1; fi; builtin command "$@"; }
AIFY_LEASE_RESIDENT_START=replace
aify_lifetime_start task8-agent claude resident SessionStart
${snapshot}`);
  assert.equal(result.status, 0, result.stderr);
  const { records, events } = JSON.parse(result.stdout);
  assert.equal(records.length, 1); assert.equal(records[0].operatorStart, undefined); assert.deepEqual(events, []);
});

const invalidMetadata = [null, [], {}, { ...capture, agentId: 'other' }, { ...capture, harness: 'hermes' },
  { ...capture, intent: 'start' }, { ...capture, producer: 'UserPromptSubmit' }, { ...capture, storeId: '' },
  { ...capture, incarnation: 0 }, { ...capture, revision: '2' }, { ...capture, stopRevision: -1 }, { ...capture, stopReceipt: 'x' }];
for (const [index, value] of invalidMetadata.entries()) test(`native writer keeps process record but drops invalid optional metadata ${index}`, t => {
  const f = fixture(t);
  const args = [path.join(ROOT, 'bin/aify-resident-record.mjs'), path.join(f.home, 'records'), 'task8-agent', 'residents', 'claude', '123',
    '/owned/claude-aify', '1780000000123456', 'w1:p3', JSON.stringify(value)];
  const result = spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(f.home, 'records', `task8-agent.${result.stdout.trim()}.json`), 'utf8'));
  assert.equal(record.operatorStart, undefined); assert.equal(record.herdrPane, 'w1:p3');
});

test('Claude hook settings wire startup only on SessionStart and retain prompt capture/turn-start', t => {
  const f = fixture(t), source = read('wrappers/claude-aify.sh.in');
  const begin = source.indexOf('AIFY_HOOK_SETTINGS="$(mktemp'), end = source.indexOf('\n# THE TURN-START RUNNER', begin);
  assert.ok(begin > 0 && end > begin, 'closed production settings region');
  const bridge = native(path.join(f.home, 'bridge with space')); fs.mkdirSync(bridge);
  fs.writeFileSync(path.join(bridge, 'agent-state-event.mjs'), `import ${JSON.stringify(new URL('./test-data/resident-start-fixture.mjs', import.meta.url).href)};\n`);
  const result = f.run(`AIFY_BRIDGE_DIR_FWD=${q(bridge)}
AIFY_WRAPPER_DIR_FWD=${q(native(ROOT))}
AIFY_HERDR_WORKING=''; AIFY_HERDR_EVENTS=''
${source.slice(begin, end)}
cat "$AIFY_HOOK_SETTINGS"\n`);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(result.stdout), hooks = name => settings.hooks[name].flatMap(group => group.hooks);
  const startup = hooks('SessionStart').filter(hook => hook.command.includes('agent-state-event.mjs'));
  assert.equal(startup.length, 1, 'native SessionStart acknowledgment registered once');
  assert.equal(startup[0].command, `node "${bridge}/agent-state-event.mjs" resident-started claude`);
  assert.equal(hooks('UserPromptSubmit').some(hook => hook.command.includes('resident-started')), false);
  for (const event of ['SessionStart', 'UserPromptSubmit']) assert.ok(hooks(event).some(hook => hook.command.includes('claude-session-hook.js')));
  assert.ok(hooks('UserPromptSubmit').some(hook => hook.command.includes('aify-turn-start.mjs')));
  assert.match(source, /aify_lifetime_start "\$\{CLAUDE_AIFY_AGENT_ID:-\}" claude "\$AIFY_SESSION_MODE" SessionStart/);
  for (const client of ['codex', 'hermes']) assert.doesNotMatch(read(`wrappers/${client}-aify.sh.in`), /resident-started|aify_lifetime_start[^\n]*SessionStart/);
  // Execute the emitted native command against an owned bridge effect collaborator, with literal native hook input.
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'owned-native-session' });
  const fired = f.run(`unset -f node\nnode() { command "$TASK8_NODE" "$@"; }\n${startup[0].command} <<'HOOK_INPUT'\n${input}\nHOOK_INPUT\n`);
  assert.equal(fired.status, 0, fired.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.env.TASK8_EVENTS, 'utf8')), {
    event: 'hook', args: ['resident-started', 'claude'], input: `${input}\n`,
  });
});
