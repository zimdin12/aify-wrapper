// Producer-only properties. Cursor/ACK/conflict/expiry recovery belong to the env shipper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ActivitySpool } from '../lib/activity-spool.mjs';
import { activityEvent } from '../lib/file-activity.mjs';
console.log(JSON.stringify({ worker: 'activity-producer', node: process.version, executable: process.execPath }));
const record = (session = 'one') => activityEvent({
  input: { session_id: session, cwd: 'C:/fixture', tool_name: 'Read', tool_input: { file_path: 'a' } },
  identity: { machineId: 'win32:fixture', instanceId: 'fixture', agentId: 'probe', incarnation: null }, outcome: 'success', observedAt: 1000,
});
function fixture(options = {}) {
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'activity-producer-')), 'activity-v2');
  const args = { directory, sessionBytes: 4096, maxSessions: 2, maxAgeMs: 86400000, now: () => 1000, uptime: () => 100, ...options };
  return { directory, args, spool: new ActivitySpool(args) };
}
const segments = directory => fs.readdirSync(directory).filter(n => n.endsWith('.jsonl'));
const lines = directory => segments(directory).flatMap(n => fs.readFileSync(path.join(directory, n), 'utf8').trimEnd().split('\n').map(JSON.parse));
function instrument(work) {
  const originals = Object.fromEntries(['openSync', 'writeSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'readdirSync'].map(k => [k, fs[k]]));
  const descriptors = new Map(), calls = [];
  fs.openSync = function(file, flags, ...args) { const fd = originals.openSync.call(this, file, flags, ...args); descriptors.set(fd, { file: String(file), flags }); return fd; };
  fs.writeSync = function(fd, buffer, ...args) { calls.push({ kind: 'write', ...descriptors.get(fd), bytes: Buffer.from(buffer) }); return originals.writeSync.call(this, fd, buffer, ...args); };
  fs.writeFileSync = function(...args) { calls.push({ kind: 'writeFile' }); return originals.writeFileSync.apply(this, args); };
  fs.fsyncSync = function(...args) { calls.push({ kind: 'fsync' }); return originals.fsyncSync.apply(this, args); };
  fs.readdirSync = function(...args) { calls.push({ kind: 'list' }); return originals.readdirSync.apply(this, args); };
  fs.closeSync = function(fd) { descriptors.delete(fd); return originals.closeSync.call(this, fd); };
  try { work(calls); } finally { Object.assign(fs, originals); }
  return calls;
}
// Old append-call test counted only .jsonl writes, concealing control rewrites and fsyncs.
test('cold and warm append each issue one full O_APPEND line, no control writes or fsync', () => {
  const f = fixture(), one = record(), two = record();
  for (const [index, value] of [one, two].entries()) {
    const calls = instrument(() => assert.equal(f.spool.append(value).ok, true));
    const writes = calls.filter(c => c.kind !== 'list');
    assert.equal(writes.length, 1, 'producer issued control writes or fsync beside the event append');
    assert.equal(writes[0].kind, 'write');
    assert.ok(writes[0].flags & fs.constants.O_APPEND);
    assert.equal(writes[0].bytes.at(-1), 10);
    assert.equal(writes[0].bytes.toString().split('\n').length, 2);
    assert.deepEqual(JSON.parse(writes[0].bytes).record, value);
    if (index) assert.equal(calls.some(c => c.kind === 'list'), false, 'warm append rescanned all sessions');
  }
  assert.equal(fs.readdirSync(f.directory).length, 1, 'producer created a control or lock file');
  assert.deepEqual(lines(f.directory).map(l => l.record), [one, two]);
});
// Owns storage-envelope clocks/policy; extraction still owns record version and field admission.
test('line binds immutable v1 record, pre-append clocks and validated policy to complete source hash', () => {
  const f = fixture({ maxAgeMs: 50 }), one = record('../raw-session');
  const original = structuredClone(one); assert.equal(f.spool.append(one).ok, true);
  const [line] = lines(f.directory);
  assert.deepEqual(line, { storageVersion: 2, appendedAt: { wallMs: 1000, uptimeMs: 100000 },
    policy: { sessionBytes: 4096, maxSessions: 2, maxAgeMs: 50 }, record: original });
  const s = one.source, digest = createHash('sha256').update(JSON.stringify([s.machineId, s.instanceId, s.agentId, s.incarnation, s.runtime, s.sessionId])).digest('hex');
  assert.deepEqual(segments(f.directory), [`session-${digest}.jsonl`]);
  assert.deepEqual(one, original, 'append mutated caller record');
  const reordered = { ...one, source: Object.fromEntries(Object.entries(one.source).reverse()) };
  assert.equal(f.spool.append(reordered).ok, true); assert.equal(segments(f.directory).length, 1);
  const other = structuredClone(one); other.source.instanceId = 'another';
  assert.equal(f.spool.append(other).ok, true); assert.equal(segments(f.directory).length, 2);
});
test('byte cap refuses the next line and retains one bounded permanent loss marker', () => {
  const f = fixture(), one = record(); assert.equal(f.spool.append(one).ok, true);
  const file = path.join(f.directory, segments(f.directory)[0]), bytes = fs.readFileSync(file);
  // A valid lower policy is included in each line; pad an already admitted segment to its exact cap.
  fs.appendFileSync(file, Buffer.alloc(f.args.sessionBytes - bytes.length, 32));
  for (let i = 0; i < 20; i++) assert.equal(f.spool.append(record()).ok, false, 'cap admitted an extra event');
  assert.equal(fs.statSync(file).size, f.args.sessionBytes);
  const markers = fs.readdirSync(f.directory).filter(n => n.endsWith('.loss'));
  assert.equal(markers.length, 1); assert.equal(fs.readFileSync(path.join(f.directory, markers[0]), 'utf8'), '?');
  assert.deepEqual(fs.readFileSync(file).subarray(0, bytes.length), bytes, 'overflow changed immutable prefix');
});
// Existing cap coverage starts with an admitted segment; it cannot detect the creation of empty
// segments and per-source markers when the first line already exceeds the configured allowance.
test('oversized first lines retain one root marker without admitting empty source segments', () => {
  const f = fixture({ sessionBytes: 1 });
  for (let i = 0; i < 40; i++) assert.equal(f.spool.append(record(`oversized-${i}`)).ok, false);
  assert.deepEqual(fs.readdirSync(f.directory), ['uncertain'], 'oversized first line created an unadmitted segment or per-source marker');
  assert.equal(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8'), '?');
  const control = fixture();
  assert.equal(control.spool.append(record()).ok, true);
  assert.equal(segments(control.directory).length, 1);
});
test('session exhaustion retains only admitted sessions and one root uncertainty byte', () => {
  const f = fixture({ maxSessions: 1 }); assert.equal(f.spool.append(record()).ok, true);
  for (let i = 0; i < 40; i++) assert.equal(f.spool.append(record(`other-${i}`)).ok, false);
  assert.equal(segments(f.directory).length, 1);
  assert.equal(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8'), '?');
  assert.equal(fs.readdirSync(f.directory).length, 2);
  assert.equal(f.spool.append(record()).ok, true, 'count bound blocked an already admitted session');
  assert.equal(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8'), '?', 'append erased uncertainty');
});
test('partial append preserves the prefix and torn bytes, marks loss and never retries the event', () => {
  const f = fixture(); assert.equal(f.spool.append(record()).ok, true);
  const file = path.join(f.directory, segments(f.directory)[0]), before = fs.readFileSync(file);
  const open = fs.openSync, write = fs.writeSync, close = fs.closeSync, descriptors = new Set(); let calls = 0;
  fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); if (String(file).endsWith('.jsonl')) descriptors.add(fd); return fd; };
  fs.closeSync = function(fd) { descriptors.delete(fd); return close.call(this, fd); };
  fs.writeSync = function(fd, buffer, ...args) { if (descriptors.has(fd)) { calls++; return write.call(this, fd, buffer, 0, 9); } return write.call(this, fd, buffer, ...args); };
  let result; try { result = f.spool.append(record()); } finally { fs.openSync = open; fs.writeSync = write; fs.closeSync = close; }
  assert.equal(result.ok, false); assert.equal(calls, 1, 'producer repaired a partial event with another append');
  const after = fs.readFileSync(file); assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(after.length, before.length + 9); assert.notEqual(after.at(-1), 10);
  assert.equal(fs.readFileSync(file.replace('.jsonl', '.loss'), 'utf8'), '?');
  assert.equal(new ActivitySpool(f.args).append(record()).ok, false, 'retained uncertainty was ignored');
  assert.deepEqual(fs.readFileSync(file), after);
});
test('write error after bytes land leaves the same bytes with a permanent uncertainty marker', () => {
  const f = fixture(), write = fs.writeSync; let fired = false;
  fs.writeSync = function(fd, buffer, ...args) { const n = write.call(this, fd, buffer, ...args); if (!fired && buffer.length > 1) { fired = true; throw new Error('owned post-write fault'); } return n; };
  try { assert.equal(f.spool.append(record()).ok, false); } finally { fs.writeSync = write; }
  assert.equal(fired, true); assert.equal(lines(f.directory).length, 1);
  assert.equal(fs.readdirSync(f.directory).filter(n => n.endsWith('.loss')).length, 1);
});
test('invalid record does not create a producer directory', () => {
  const f = fixture(); assert.equal(f.spool.append({ ...record(), version: 2 }).ok, false);
  assert.equal(fs.existsSync(f.directory), false);
});
// No old test bounded the marker path when storage admission fails for new identities.
test('unadmitted sessions cannot multiply loss files on repeated storage refusal', () => {
  const f = fixture(); fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, 'foreign'), 'keep');
  for (let i = 0; i < 20; i++) assert.equal(f.spool.append(record(`refused-${i}`)).ok, false);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['foreign', 'uncertain']);
  assert.equal(fs.readFileSync(path.join(f.directory, 'foreign'), 'utf8'), 'keep');
});
test('an exact remaining byte allowance admits a full line but not its next byte', () => {
  const f = fixture(), one = record(); assert.equal(f.spool.append(one).ok, true);
  const file = path.join(f.directory, segments(f.directory)[0]), first = fs.readFileSync(file);
  fs.appendFileSync(file, Buffer.alloc(f.args.sessionBytes - 2 * first.length, 32));
  assert.equal(f.spool.append(one).ok, true, 'exact byte allowance refused');
  assert.equal(fs.statSync(file).size, f.args.sessionBytes);
  assert.equal(f.spool.append(one).ok, false, 'full segment admitted another line');
});
for (const ancestor of [false, true]) test(`admission refuses ${ancestor ? 'ancestor' : 'root'} junction without external writes`, () => {
  const f = fixture(), external = path.join(path.dirname(f.directory), 'external'); fs.mkdirSync(external);
  fs.symlinkSync(external, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  const directory = ancestor ? path.join(f.directory, 'nested') : f.directory;
  assert.equal(new ActivitySpool({ ...f.args, directory }).append(record()).ok, false);
  assert.deepEqual(fs.readdirSync(external), []);
  assert.equal(fixture().spool.append(record()).ok, true);
});
test('admission refuses a linked session segment rather than writing to its target', () => {
  const f = fixture(); assert.equal(f.spool.append(record()).ok, true);
  const file = path.join(f.directory, segments(f.directory)[0]), external = path.join(path.dirname(f.directory), 'external');
  fs.unlinkSync(file); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'sentinel'), 'keep');
  fs.symlinkSync(external, file, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.spool.append(record()).ok, false); assert.deepEqual(fs.readdirSync(external), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(external, 'sentinel'), 'utf8'), 'keep');
});
test('invalid clock produces no event and leaves uncertainty instead of inventing fresh age', () => {
  const f = fixture({ now: () => NaN }); assert.equal(f.spool.append(record()).ok, false);
  assert.deepEqual(segments(f.directory), []); assert.equal(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8'), '?');
});
test('absolute root and policy limits fail closed without retaining consumer APIs', () => {
  for (const options of [{ directory: 'relative' }, { sessionBytes: 8388609 }, { maxSessions: 17 }, { maxAgeMs: 86400001 }]) {
    assert.throws(() => new ActivitySpool({ directory: path.resolve('fixture'), ...options }));
  }
  const f = fixture(); for (const name of ['read', 'resolve', 'ack']) assert.equal(f.spool[name], undefined, 'consumer queue API remained in producer');
});
