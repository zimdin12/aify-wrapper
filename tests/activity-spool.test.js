import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { ActivitySpool, CONTROL_BYTES, spoolLogicalBound } from '../lib/activity-spool.mjs';
import { MUTEX_BYTES } from '../lib/activity-storage.mjs';
import { activityEvent } from '../lib/file-activity.mjs';
console.log(JSON.stringify({ worker: 'activity-spool', node: process.version, executable: process.execPath }));

const record = (session = 'one') => activityEvent({
  input: { session_id: session, cwd: 'C:/fixture', tool_name: 'Read', tool_input: { file_path: 'a' } },
  identity: { machineId: 'win32:fixture', instanceId: 'fixture', agentId: 'probe', incarnation: null }, outcome: 'success', observedAt: 1000,
});
function fixture(options = {}) {
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'activity-spool-')), 'spool');
  let clock = { wall: 1000, uptime: 100 };
  const args = { directory, sessionBytes: 2048, maxSessions: 2, now: () => clock.wall, uptime: () => clock.uptime, ...options };
  return { directory, args, spool: new ActivitySpool(args), setClock: (wall, uptime) => { clock = { wall, uptime }; } };
}
const files = directory => fs.readdirSync(directory).filter(n => n.endsWith('.jsonl'));
const bytes = directory => fs.readdirSync(directory).reduce((sum, n) => {
  const stat = fs.lstatSync(path.join(directory, n)); return sum + (stat.isFile() ? stat.size : 0);
}, 0);
const ack = (spool, batch) => spool.ack(batch.token, { committed: true, eventIds: batch.token.eventIds, gapIds: batch.token.gapIds });

test('exact byte boundary permits a complete line and refuses the next without exceeding logical bound', () => {
  const one = record(); const size = Buffer.byteLength(JSON.stringify(one) + '\n');
  const { spool, directory } = fixture({ sessionBytes: size });
  assert.equal(spool.append(one).ok, true);
  assert.equal(spool.append(record()).ok, false, 'cap did not refuse a second line');
  const batch = spool.read();
  assert.equal(batch.records.length, 1);
  assert.equal(batch.gap.reason, 'capacity');
  assert.equal(batch.gap.lostCount, null);
  assert.ok(bytes(directory) <= spoolLogicalBound({ sessionBytes: size, maxSessions: 2 }));
  assert.equal(spoolLogicalBound({ sessionBytes: size, maxSessions: 2 }), size * 2 + CONTROL_BYTES * 2 + MUTEX_BYTES + 1);
});

test('session count overflow latches durable root-wide uncertainty without retaining excess identities', () => {
  const { spool, directory, args } = fixture({ maxSessions: 1 });
  spool.append(record('one'));
  for (let i = 0; i < 100; i++) spool.append(record(`other-${i}`));
  assert.equal(files(directory).length, 1, 'retained excess session files');
  const reopened = new ActivitySpool(args).read();
  assert.equal(reopened.records.length, 1);
  assert.equal(reopened.coverage, 'unknown', 'unretained sessions cannot be attributed to the retained source');
  assert.ok(bytes(directory) <= spoolLogicalBound({ sessionBytes: 2048, maxSessions: 1 }));
  assert.equal(files(directory).length, 1);
});

test('old gap ACK cannot clear a newer loss generation; exact ACK clears it', () => {
  const one = record(); const size = Buffer.byteLength(JSON.stringify(one) + '\n');
  const { spool, args } = fixture({ maxSessions: 1, sessionBytes: size });
  spool.append(one); spool.append(record());
  const old = spool.read();
  spool.append(record());
  const newer = spool.read(), stale = ack(spool, old);
  assert.equal(new ActivitySpool(args).read().gap?.id, newer.gap.id, 'old ACK cleared durable new loss');
  assert.equal(stale.ok, false, 'old ACK cleared a new loss');
  const current = spool.read();
  assert.ok(current.generation > old.generation);
  assert.equal(ack(spool, current).ok, true);
  assert.equal(new ActivitySpool(args).read().gap, null);
});

test('ACK binds immutable file content, not a reused filename or offset', () => {
  const { spool, directory, args } = fixture(); spool.append(record());
  const before = spool.read();
  const file = path.join(directory, files(directory)[0]);
  const replacement = structuredClone(before.records[0].record);
  replacement.event.path.raw = 'b'; replacement.event.path.canonical = 'C:/fixture/b';
  const other = JSON.stringify(replacement) + '\n';
  fs.writeFileSync(file, other);
  const result = ack(spool, before);
  assert.equal(new ActivitySpool(args).read().records.length, 1, 'replacement content was durably acknowledged');
  assert.equal(result.ok, false, 'replacement content acknowledged');
});

test('torn tail never becomes an event and is converted to an explicit gap', () => {
  const { spool, directory } = fixture(); spool.append(record());
  fs.appendFileSync(path.join(directory, files(directory)[0]), '{"event":');
  const batch = spool.read();
  assert.equal(batch.records.length, 0, 'corrupt segment was sent');
  assert.equal(batch.gap.reason, 'corrupt');
});

test('first append age survives reopen and retries; expired records require gap ACK', () => {
  const f = fixture({ maxAgeMs: 100 }); f.spool.append(record());
  f.setClock(1090, 100.09); assert.equal(new ActivitySpool(f.args).read().records.length, 1);
  f.spool.append(record());
  f.setClock(1100, 100.1);
  const expired = new ActivitySpool(f.args).read();
  assert.equal(expired.records.length, 0, 'retry renewed the first durable append age');
  assert.equal(expired.gap.reason, 'expired');
});

for (const [name, wall, uptime] of [['rollback', 999, 101], ['reboot', 1001, 1], ['wall step', 1050, 200]]) {
  test(`uncertain age after ${name} is a coverage gap, not young content`, () => {
    const f = fixture(); f.spool.append(record()); f.setClock(wall, uptime);
    const batch = f.spool.read();
    assert.equal(batch.records.length, 0);
    assert.equal(batch.gap.reason, 'clock');
  });
}

// The draft only proved permanent refusal behind an orphan. This proves automatic recovery.
test('a crashed native lock holder cannot wedge subsequent appends', async () => {
  const { directory, args } = fixture(); fs.mkdirSync(directory);
  const code = `const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(${JSON.stringify(path.join(directory, 'mutex.sqlite'))}); d.exec('CREATE TABLE IF NOT EXISTS mutex(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE'); process.exit(0);`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_|HERMES_SESSION_ID$|NODE_OPTIONS$)/i.test(k)));
  const exit = await new Promise(resolve => { const p = spawn(process.execPath, ['-e', code], { env, stdio: 'ignore' }); p.on('exit', resolve); });
  assert.equal(exit, 0);
  assert.equal(new ActivitySpool(args).append(record()).ok, true, 'crashed holder wedged append');
  assert.equal(new ActivitySpool(args).read().records.length, 1);
});

test('interrupted transaction becomes a durable gap on restart', () => {
  const f = fixture(); f.spool.append(record());
  const file = path.join(f.directory, 'control');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.pending = state.slots[0].id;
  state.slots[0].size = 0;
  fs.writeFileSync(file, JSON.stringify(state).padEnd(CONTROL_BYTES, ' '));
  const batch = new ActivitySpool(f.args).read();
  assert.equal(batch.records.length, 0);
  assert.equal(batch.gap.reason, 'interrupted');
  assert.equal(fs.statSync(path.join(f.directory, 'slot-0.jsonl')).size, 0, 'uncommitted tail was not truncated');
});

test('parallel native writers share one hard byte budget', async () => {
  const f = fixture({ sessionBytes: 2048, maxSessions: 1 });
  const module = new URL('../lib/activity-spool.mjs', import.meta.url).href;
  const payload = JSON.stringify(record());
  const code = `import {ActivitySpool} from ${JSON.stringify(module)}; const spool=new ActivitySpool(${JSON.stringify({directory:f.directory,sessionBytes:2048,maxSessions:1,lockWaitMs:3000})}); for(let i=0;i<10;i++) spool.append(${payload});`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_|HERMES_SESSION_ID$|NODE_OPTIONS$)/i.test(k)));
  const exits = await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: 'ignore' });
    p.on('exit', resolve); p.on('error', () => resolve(-1));
  })));
  assert.deepEqual(exits, [0,0,0,0,0,0]);
  const retained = files(f.directory).map(n => fs.statSync(path.join(f.directory,n)).size);
  assert.ok(retained.length > 0, 'positive control appended nothing');
  assert.ok(retained.every(n => n <= 2048), 'parallel writers exceeded cap');
  assert.ok(bytes(f.directory) <= spoolLogicalBound({ sessionBytes: 2048, maxSessions: 1 }));
});

for (const ancestor of [false, true]) test(`spool refuses ${ancestor ? 'ancestor' : 'root'} junction without modifying external data`, () => {
  const f = fixture(); const external = path.join(path.dirname(f.directory), 'external'); fs.mkdirSync(external);
  fs.symlinkSync(external, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  const directory = ancestor ? path.join(f.directory, 'activity') : f.directory;
  const result = new ActivitySpool({ ...f.args, directory }).append(record());
  assert.deepEqual(fs.readdirSync(external), [], 'refused admission modified external data');
  assert.equal(result.ok, false, 'external root was admitted');
  const control = fixture(); assert.equal(control.spool.append(record()).ok, true);
});

// No existing case proves record-level conflict recovery, restart identity or unrelated resubmission.
test('conflicting event becomes a stable durable gap while the unrelated event remains sendable', () => {
  const f = fixture(); const bad = record(), good = record();
  f.spool.append(bad); f.spool.append(good);
  const before = f.spool.read();
  assert.equal(typeof f.spool.resolve, 'function', 'no record-level conflict recovery');
  assert.equal(f.spool.resolve(before.token, { eventIds: [bad.event.eventId], reason: 'event_conflict' }).ok, true);
  const restart = new ActivitySpool(f.args).read();
  assert.deepEqual(restart.records.map(e => e.record.event.eventId), [good.event.eventId]);
  assert.equal(restart.gaps[0].reason, 'event_conflict');
  const gapId = restart.gaps[0].id;
  assert.equal(new ActivitySpool(f.args).read().gaps[0].id, gapId, 'restart regenerated gap identity');
  const uncommitted = f.spool.ack(restart.token, { committed: false, eventIds: [good.event.eventId], gapIds: [gapId] });
  assert.equal(new ActivitySpool(f.args).read().records.length, 1, 'uncommitted ACK advanced durable cursor');
  assert.equal(uncommitted.ok, false);
  assert.equal(f.spool.ack(restart.token, { committed: true, eventIds: [good.event.eventId], gapIds: [gapId] }).ok, true);
  assert.equal(new ActivitySpool(f.args).read().records.length, 0);
});

test('gap conflict replaces only the named marker and stale ACK cannot erase its replacement', () => {
  const f = fixture(); f.spool.append(record());
  const first = f.spool.read(); f.spool.resolve(first.token, { eventIds: first.token.eventIds, reason: 'refused' });
  const before = f.spool.read();
  assert.equal(typeof f.spool.resolve, 'function', 'no gap-level conflict recovery');
  assert.equal(f.spool.resolve(before.token, { gapIds: [before.gap.id], reason: 'gap_conflict' }).ok, true);
  const after = new ActivitySpool(f.args).read();
  assert.notEqual(after.gaps[0].id, before.gap.id);
  assert.equal(after.gaps[0].reason, 'gap_conflict');
  assert.equal(new ActivitySpool(f.args).read().gaps[0].id, after.gaps[0].id);
  assert.equal(f.spool.ack(before.token, { committed: true, eventIds: before.token.eventIds, gapIds: [before.gap.id] }).ok, false);
  assert.equal(new ActivitySpool(f.args).read().gaps[0].id, after.gaps[0].id);
});

// The draft let competing writers choose incompatible bounds for one root. No existing test checks policy identity.
for (const [field, value] of [['sessionBytes', 4096], ['maxSessions', 3], ['maxAgeMs', 200]]) test(`root policy refuses a second ${field} budget`, () => {
  const f = fixture(); assert.equal(f.spool.append(record()).ok, true);
  assert.equal(new ActivitySpool({ ...f.args, [field]: value }).append(record()).ok, false, 'root policy was silently changed');
  assert.equal(new ActivitySpool(f.args).read().records.length, 1, 'policy refusal altered durable events');
});

test('terminal refusal remains durable until its committed gap ACK, then advances a reopened cursor', () => {
  const f = fixture(); const one = record(); f.spool.append(one); const first = f.spool.read();
  assert.equal(f.spool.resolve(first.token, { eventIds: [one.event.eventId], reason: 'refused' }).ok, true);
  const refused = new ActivitySpool(f.args).read();
  assert.deepEqual(refused.records, []); assert.equal(refused.gaps.length, 1, 'terminal refusal was not durably visible');
  assert.equal(refused.gaps[0].reason, 'refused');
  assert.equal(f.spool.ack(refused.token, { committed: true, eventIds: [], gapIds: [] }).ok, false, 'uncommitted refusal gap advanced cursor');
  assert.equal(new ActivitySpool(f.args).read().gaps[0].id, refused.gaps[0].id);
  assert.equal(ack(f.spool, refused).ok, true);
  assert.equal(new ActivitySpool(f.args).read().source, null);
});

test('unknown conflict IDs and an old segment token cannot discard unrelated new content', () => {
  const f = fixture(); f.spool.append(record()); const first = f.spool.read();
  assert.equal(f.spool.resolve(first.token, { eventIds: ['11111111-1111-1111-1111-111111111111'], reason: 'event_conflict' }).ok, false);
  assert.equal(new ActivitySpool(f.args).read().records.length, 1);
  assert.equal(ack(f.spool, first).ok, true);
  f.spool.append(record());
  assert.equal(ack(f.spool, first).ok, false, 'reused slot admitted an old segment ACK');
  assert.equal(new ActivitySpool(f.args).read().records.length, 1);
});

// Previous tests checked final size, not the atomic write call or full multi-page recovery.
test('each complete event uses exactly one O_APPEND write and reopens as the same immutable body', () => {
  const f = fixture(), one = record(); const opened = new Map(), writes = [];
  const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
  fs.openSync = function(file, flags, ...rest) { const fd = open.call(this, file, flags, ...rest); if (String(file).endsWith('.jsonl')) opened.set(fd, flags); return fd; };
  fs.writeSync = function(fd, buffer, ...rest) { if (opened.has(fd)) writes.push({ flags: opened.get(fd), bytes: Buffer.from(buffer).toString() }); return write.call(this, fd, buffer, ...rest); };
  fs.closeSync = function(fd) { opened.delete(fd); return close.call(this, fd); };
  try { assert.equal(f.spool.append(one).ok, true); } finally { fs.openSync = open; fs.writeSync = write; fs.closeSync = close; }
  assert.equal(writes.length, 1, 'event line split across append writes');
  assert.ok(writes[0].flags & fs.constants.O_APPEND);
  assert.equal(writes[0].bytes, JSON.stringify(one) + '\n');
  assert.deepEqual(new ActivitySpool(f.args).read().records[0].record, one);
});

test('more than 32 recovery gaps drain in bounded pages without renewing IDs or losing the unaffected record', () => {
  const f = fixture({ sessionBytes: 100000 });
  for (let i = 0; i < 34; i++) f.spool.append(record());
  const good = record(); f.spool.append(good); const first = f.spool.read();
  assert.equal(f.spool.resolve(first.token, { eventIds: first.token.eventIds.slice(0, 34), reason: 'event_conflict' }).ok, true);
  const a = new ActivitySpool(f.args).read(); assert.equal(a.gaps.length, 32); assert.deepEqual(a.token.eventIds, [good.event.eventId]);
  assert.deepEqual(ack(f.spool, a), { ok: true, advanced: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'control'))).slots[0].cursor, 0, 'partial gap ACK advanced prefix');
  const b = new ActivitySpool(f.args).read(); assert.equal(b.gaps.length, 2); assert.deepEqual(b.token.eventIds, [good.event.eventId]);
  assert.equal(ack(f.spool, b).ok, true);
  assert.equal(new ActivitySpool(f.args).read().source, null);
  assert.ok(bytes(f.directory) <= spoolLogicalBound({ sessionBytes: 100000, maxSessions: 2 }));
});

test('parallel independent sessions cannot race past the per-agent session bound', async () => {
  const f = fixture({ maxSessions: 2 });
  const module = new URL('../lib/activity-spool.mjs', import.meta.url).href;
  const code = `import {ActivitySpool} from ${JSON.stringify(module)}; const record=${JSON.stringify(record())}; record.source.sessionId=process.argv[1]; new ActivitySpool(${JSON.stringify({ directory: f.directory, sessionBytes: 2048, maxSessions: 2, lockWaitMs: 3000 })}).append(record);`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_|HERMES_SESSION_ID$|NODE_OPTIONS$)/i.test(k)));
  const exits = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, `session-${i}`], { env, stdio: 'ignore' });
    child.on('exit', resolve); child.on('error', () => resolve(-1));
  })));
  assert.deepEqual(exits, [0, 0, 0, 0, 0, 0]);
  assert.equal(files(f.directory).length, 2, 'parallel writers retained excess sessions');
  assert.equal(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8'), '?');
  assert.ok(bytes(f.directory) <= spoolLogicalBound({ sessionBytes: 2048, maxSessions: 2 }));
});

// Initialization's temp-file crash point is distinct from an interrupted event append.
test('crash before the first control rename recovers with durable unknown coverage', () => {
  const f = fixture(); fs.mkdirSync(f.directory);
  fs.writeFileSync(path.join(f.directory, 'control.tmp'), Buffer.alloc(CONTROL_BYTES, 32));
  assert.equal(f.spool.append(record()).ok, true, 'initial control temp wedged the root');
  const after = new ActivitySpool(f.args).read();
  assert.equal(after.coverage, 'unknown'); assert.equal(after.records.length, 1);
  assert.ok(bytes(f.directory) <= spoolLogicalBound({ sessionBytes: 2048, maxSessions: 2 }));
});

test('a smaller recovery read cannot ACK gaps for a prefix it did not read', () => {
  const f = fixture(); f.spool.append(record()); f.spool.append(record());
  const first = f.spool.read(); f.spool.resolve(first.token, { eventIds: [first.token.eventIds[1]], reason: 'event_conflict' });
  const small = f.spool.read({ maxBytes: 1 });
  assert.equal(small.ok, false, 'partial recovery range was issued as an ACK token');
  assert.equal(small.reason, 'recovery-read-limit');
  const current = new ActivitySpool(f.args).read();
  assert.equal(current.records.length, 1); assert.equal(current.gaps.length, 1);
  assert.equal(ack(f.spool, current).ok, true);
  assert.equal(new ActivitySpool(f.args).read().source, null);
});

// These crash points execute real writes, unlike the earlier pending-control fixture.
test('interrupted ACK publication preserves either original recovery or the fully committed retirement', () => {
  const f = fixture(); const bad = record(), good = record(); f.spool.append(bad); f.spool.append(good);
  const first = f.spool.read(); f.spool.resolve(first.token, { eventIds: [bad.event.eventId], reason: 'event_conflict' });
  const before = f.spool.read(), rename = fs.renameSync; let fired = false;
  fs.renameSync = function(from, to) { const state = JSON.parse(fs.readFileSync(from, 'utf8')); const result = rename.call(this, from, to); if (!fired && (state.pending || state.slots.some(s => s.retired || s.cursor > 0))) { fired = true; throw new Error('owned publication crash'); } return result; };
  try { ack(f.spool, before); } finally { fs.renameSync = rename; }
  assert.equal(fired, true, 'fault never reached a real control publication');
  const after = new ActivitySpool(f.args).read();
  const actual = { events: after.records.map(e => e.record.event.eventId), gaps: after.gaps.map(g => g.id), files: files(f.directory).length };
  const original = { events: [good.event.eventId], gaps: before.gaps.map(g => g.id), files: 1 };
  assert.ok(JSON.stringify(actual) === JSON.stringify(original) || JSON.stringify(actual) === JSON.stringify({ events: [], gaps: [], files: 0 }), 'ACK crash rewrote durable recovery or failed committed retirement');
});

test('an interrupted append preserves the old prefix and stable conflict markers', () => {
  const f = fixture(); const bad = record(), good = record(); f.spool.append(bad); f.spool.append(good);
  const first = f.spool.read(); f.spool.resolve(first.token, { eventIds: [bad.event.eventId], reason: 'event_conflict' });
  const before = f.spool.read(), open = fs.openSync, write = fs.writeSync; const descriptors = new Set(); let fired = false;
  fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); if (String(file).endsWith('.jsonl')) descriptors.add(fd); return fd; };
  fs.writeSync = function(fd, ...args) { const result = write.call(this, fd, ...args); if (!fired && descriptors.has(fd)) { fired = true; throw new Error('owned append crash'); } return result; };
  try { f.spool.append(record()); } finally { fs.openSync = open; fs.writeSync = write; }
  assert.equal(fired, true, 'fault never reached a real append');
  const after = new ActivitySpool(f.args).read();
  assert.deepEqual(after.records.map(e => e.record), [good], 'append crash discarded unrelated committed prefix');
  assert.ok(after.gaps.some(g => g.id === before.gaps[0].id), 'append crash regenerated the durable conflict marker');
  assert.ok(after.gaps.some(g => g.reason === 'interrupted'));
});
