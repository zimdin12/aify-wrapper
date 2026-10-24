// Run only in an exclusively owned tree. Every mutation is restored in finally, then tested healthy.
// Usage: <absolute-node> docs/evidence/activity-6/guard-plants.mjs <unique-label> --owned-tree [plant,...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const label = process.argv[2];
if (!/^[a-z0-9-]+$/.test(label || '') || process.argv[3] !== '--owned-tree') throw new Error('explicit unique label and exclusive-tree permission required');
const output = path.join(ROOT, '.check-output/activity-6', label);
fs.mkdirSync(output); // Refuse reuse before opening any transcript.
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
const hash = b => createHash('sha256').update(b).digest('hex');
const extractor = 'lib/file-activity.mjs', spool = 'lib/activity-spool.mjs', storage = 'lib/activity-storage.mjs', runner = 'bin/aify-tool-event.mjs';
const tests = ['tests/file-activity.test.js', 'tests/activity-spool.test.js', 'tests/activity-launcher.test.js', 'tests/herdr-tool-parity.test.js', 'tests/file-activity-capability.test.js'];
const read = p => fs.readFileSync(path.join(ROOT, p));
const artifacts = new Set([extractor, spool, storage, runner, 'lib/herdr-tool-state.mjs', 'lib/registry.mjs', 'lib/service-spec.mjs', 'wrappers/claude-aify.sh.in', ...tests]);
const bindings = () => Object.fromEntries([...artifacts].map(p => [p, hash(read(p))]));
const receipts = [];
function record(receipt) { receipts.push(receipt); fs.appendFileSync(path.join(output, 'receipts.jsonl'), JSON.stringify(receipt) + '\n'); }
function execute(name, files, expected = null) {
  const args = [npm, '--script-shell=' + shell, 'test', '--', ...files];
  const before = bindings();
  const run = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  const raw = (run.stdout || '') + (run.stderr || '');
  const log = name + '.txt'; fs.writeFileSync(path.join(output, log), raw, { flag: 'wx' });
  const failed = [...new Set([...raw.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?\r?$/gm)].map(m => m[1].trim()).filter(name => name !== 'failing tests:'))];
  const total = Number(/(?:#|ℹ) tests (\d+)/.exec(raw)?.[1] || 0);
  const skipped = Number(/(?:#|ℹ) skipped (\d+)/.exec(raw)?.[1] || 0);
  const receipt = { name, node: process.version, executable: process.execPath, executableSha256: hash(fs.readFileSync(process.execPath)),
    command: [process.execPath, ...args], source: before, exit: run.status, signal: run.signal, log, sha256: hash(raw), total, skipped, failed, expected };
  record(receipt);
  if (expected) {
    if (run.status === 0 || !failed.includes(expected.test) || expected.message && !raw.includes(expected.message)) throw new Error('plant did not reach its predicted assertion: ' + name);
  } else if (run.status !== 0 || skipped || !total || failed.length) throw new Error('healthy control failed: ' + name);
  console.log(JSON.stringify({ name, exit: run.status, total, failed }));
}
const P = (name, file, edits, testIndex, test, message) => ({ name, file, edits, testIndex, expected: { test, ...(message ? { message } : {}) } });
const exact = 'exact byte boundary permits a complete line and refuses the next without exceeding logical bound';
const oldGap = 'old gap ACK cannot clear a newer loss generation; exact ACK clears it';
const eventConflict = 'conflicting event becomes a stable durable gap while the unrelated event remains sendable';
const gapConflict = 'gap conflict replaces only the named marker and stale ACK cannot erase its replacement';
const enabled = 'activity enabled without Herdr executes one native hook per outcome, argv conversion false';
const plants = [
  P('raw-field-leak', extractor, [['toolCallId: input.tool_use_id ?? null', 'toolCallId: JSON.stringify(input.tool_input)']], 0, 'only approved file-tool fields reach immutable event bytes', 'raw tool fields leaked'),
  ...['session', 'agent', 'instance', 'machine'].map(field => {
    const target = field === 'session' ? 'input' : 'identity', key = field === 'session' ? 'session_id' : field + 'Id';
    return P('borrow-' + field, extractor, [['  if (!input || !identity ||', `  ${target} = {...${target}, ${key}: ${target}.${key} || 'borrowed-parent'};\n  if (!input || !identity ||`]], 0, `refuse missing ${field} instead of borrowing identity or paths`);
  }),
  P('child-identity', extractor, [["if (['agent_id',", "if (false && ['agent_id',"]], 0, 'refuse subagent ambiguity instead of borrowing identity or paths'),
  P('bash-attribution', extractor, [["Read: 'read', Write:", "Bash: 'write', Read: 'read', Write:"]], 0, 'Bash with a file-looking command produces no spool line; Read positive control does'),
  P('disabled-append', runner, [['if (config.enabled &&', 'if (true &&']], 0, 'disabled and malformed configuration never append'),
  P('herdr-only-install', 'wrappers/claude-aify.sh.in', [['elif [ "${AIFY_FILE_ACTIVITY:-0}" = 1 ]; then', 'elif false; then']], 2, enabled, 'parallel observer or missing combined hook'),
  P('parser-child', runner, [["import os from 'node:os';", "import os from 'node:os';\nimport {spawnSync} from 'node:child_process';\nspawnSync(process.execPath,['-e','JSON.parse(\"{}\")'],{env:process.env,stdio:'ignore'});"]], 2, enabled, 'second parser process started'),
  P('state-coupled-to-json', runner, [['reportToolWorking({ env: process.env, firedAt });', ''], ["const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));", "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));\n      reportToolWorking({ env: process.env, firedAt });"]], 2, 'malformed input, disabled config, unsupported tool, missing identity and storage failure cannot suppress working', 'activity failure suppressed existing working report'),
  P('activity-coupled-to-pane', runner, [['if (config.enabled &&', 'if (process.env.AIFY_HERDR_PANE_ID && config.enabled &&']], 2, 'missing and refused Herdr targets cannot suppress valid activity', 'missing/refused Herdr suppressed activity'),
  P('byte-bound', spool, [['slot.size + line.length > this.sessionBytes', 'false']], 1, exact, 'cap did not refuse a second line'),
  P('session-bound', spool, [['if (state.slots.length >= this.maxSessions)', 'if (false)']], 1, 'session count overflow latches durable root-wide uncertainty without retaining excess identities', 'retained excess session files'),
  P('single-append', spool, [['const written = fs.writeSync(fd, line);', 'const cut=Math.floor(line.length/2); const written=fs.writeSync(fd,line.subarray(0,cut))+fs.writeSync(fd,line.subarray(cut));']], 1, 'each complete event uses exactly one O_APPEND write and reopens as the same immutable body', 'event line split across append writes'),
  P('orphan-file-lock', storage, [['this.admit(); admitted = true;', "this.admit(); admitted = true; if(fs.existsSync(this.file('mutex.sqlite'))) return {ok:false,reason:'locked'};"]], 1, 'a crashed native lock holder cannot wedge subsequent appends', 'crashed holder wedged append'),
  P('interrupted-append', spool, [['if (state.pending === slot.id) this.#recoverAppend(state, slot);', 'if (false) this.#recoverAppend(state, slot);']], 1, 'interrupted transaction becomes a durable gap on restart'),
  P('expiry', spool, [['wall - slot.firstAt >= this.maxAgeMs || (up - slot.firstUptime) * 1000 >= this.maxAgeMs', 'false']], 1, 'first append age survives reopen and retries; expired records require gap ACK', 'retry renewed the first durable append age'),
  P('clock-uncertainty', spool, [["const clock = wall < state.lastAt || up < state.lastUptime || Math.abs((wall - state.lastAt) - (up - state.lastUptime) * 1000) > 2000;", 'const clock = false;'], ['clock || Math.abs((wall - slot.firstAt) - (up - slot.firstUptime) * 1000) > 2000', 'false']], 1, 'uncertain age after rollback is a coverage gap, not young content'),
  P('root-admission', storage, [["if (fs.lstatSync(current).isSymbolicLink()) throw new Error('unsafe activity root');", 'fs.lstatSync(current);']], 1, 'spool refuses root junction without modifying external data', 'refused admission modified external data'),
  P('content-ack', spool, [[' || digest(data.subarray(0, receipt.end)) !== receipt.digest', '']], 1, 'ACK binds immutable file content, not a reused filename or offset', 'replacement content was durably acknowledged'),
  P('old-gap-ack', spool, [[' || token.generation !== state.generation', ''], ['if (!same(gaps, token.gapIds)) return null;', ''], ['if (slot.loss && gapIds.includes(slot.loss.id)) slot.loss = null;', 'if (slot.loss) slot.loss = null;']], 1, oldGap, 'old ACK cleared durable new loss'),
  P('uncommitted-ack', spool, [['!slot || !committed ||', '!slot ||']], 1, eventConflict, 'uncommitted ACK advanced durable cursor'),
  P('refusal-marker', spool, [['recovery.gaps.push(marker);', 'void marker;']], 1, 'terminal refusal remains durable until its committed gap ACK, then advances a reopened cursor', 'terminal refusal was not durably visible'),
  P('conflict-drops-unrelated', spool, [['if (!recovery?.excluded.some(e => e.eventId === record.event.eventId))', 'if (!recovery)']], 1, eventConflict),
  P('gap-conflict-reuses-id', spool, [['const id = randomUUID();', 'const id = gapId;']], 1, gapConflict),
  P('policy-mismatch', spool, [["if (!same(state.policy, { sessionBytes: this.sessionBytes, maxSessions: this.maxSessions, maxAgeMs: this.maxAgeMs })) throw new Error('activity policy mismatch');", '']], 1, 'root policy refuses a second sessionBytes budget', 'root policy was silently changed'),
  P('capability-guard', 'lib/registry.mjs', [['if (!isPlainObject(value) || Object.keys(value).length !== 1 || value.path !== "/api/v1/file-activity") {', 'if (false) {'], ['return { path: value.path };', 'return value;']], 4, 'activity registry refuses foreign route without guessing a capability'),
  P('initial-publish-crash', storage, [["'uncertain', 'control.tmp'].includes(n)", "'uncertain'].includes(n)"]], 1, 'crash before the first control rename recovers with durable unknown coverage', 'initial control temp wedged the root'),
  P('torn-tail', spool, [["if (this.store.regular(this.#segment(slot)).size !== slot.size)", 'if (false)'], ["if (!end || end > through) { this.#discard(state, slot, 'corrupt'); records.length = 0; break; }", 'if (!end || end > through) break;']], 1, 'torn tail never becomes an event and is converted to an explicit gap', 'corrupt segment was sent'),
  P('recovery-range', spool, [['if (recovery && !slot.discard && offset !== through)', 'if (false)']], 1, 'a smaller recovery read cannot ACK gaps for a prefix it did not read', 'partial recovery range was issued as an ACK token'),
  P('ack-marked-pending', spool, [['// Publish the committed disposition atomically. An ACK never marks other data as pending.', "state.pending=slot.id; this.store.publish(state);"]], 1, 'interrupted ACK publication preserves either original recovery or the fully committed retirement', 'ACK crash rewrote durable recovery or failed committed retirement'),
  P('append-discards-prefix', spool, [["this.#loss(state, slot, 'interrupted');", "this.#discard(state, slot, 'interrupted');"]], 1, 'an interrupted append preserves the old prefix and stable conflict markers', 'append crash discarded unrelated committed prefix'),
  P('append-regenerates-conflict', spool, [["this.#loss(state, slot, 'interrupted');", "this.#loss(state, slot, 'interrupted'); for(const g of state.recovery?.gaps || []) g.id=randomUUID();"]], 1, 'an interrupted append preserves the old prefix and stable conflict markers', 'append crash regenerated the durable conflict marker'),
  P('retirement-cleanup', spool, [['if (slot.retired) { this.#remove(state, slot); continue; }', 'if (slot.retired) continue;']], 1, 'interrupted ACK publication preserves either original recovery or the fully committed retirement', 'ACK crash rewrote durable recovery or failed committed retirement'),
];
const selected = process.argv[4] ? plants.filter(p => process.argv[4].split(',').includes(p.name)) : plants;
if (!selected.length) throw new Error('no named plants');
execute('healthy', tests);
for (const plant of selected) {
  const original = read(plant.file), originalHash = hash(original);
  let changed = original.toString('utf8');
  for (const [before, after] of plant.edits) {
    if (changed.split(before).length !== 2) throw new Error('nonunique mutation anchor: ' + plant.name);
    changed = changed.replace(before, after);
  }
  try {
    fs.writeFileSync(path.join(ROOT, plant.file), changed);
    const args = plant.file.endsWith('.in') ? ['-n', path.join(ROOT, plant.file)] : ['--check', path.join(ROOT, plant.file)];
    const compile = spawnSync(plant.file.endsWith('.in') ? 'bash' : process.execPath, args, { env, cwd: ROOT, encoding: 'utf8' });
    record({ name: plant.name + '-compile', node: process.version, exit: compile.status, stdout: compile.stdout, stderr: compile.stderr,
      source: plant.file, originalHash, mutantHash: hash(changed), edits: plant.edits, expected: plant.expected });
    if (compile.status !== 0) throw new Error('mutant did not compile: ' + plant.name);
    execute(plant.name + '-red', [tests[plant.testIndex]], plant.expected);
  } finally {
    fs.writeFileSync(path.join(ROOT, plant.file), original);
    if (hash(read(plant.file)) !== originalHash) throw new Error('failed restoration');
  }
  execute(plant.name + '-restored', [tests[plant.testIndex]]);
}
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ node: process.version, executable: process.execPath, plants: selected.map(p => p.name), receipts }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ node: process.version, completed: selected.length, output }));
