// Bounded named-file journal. The shipper owns HTTP validation; this owner binds durable dispositions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { validActivityRecord } from './file-activity.mjs';
import ActivityStorage, { CONTROL_BYTES, MUTEX_BYTES } from './activity-storage.mjs';
export { CONTROL_BYTES } from './activity-storage.mjs';
export const spoolLogicalBound = ({ sessionBytes = 8388608, maxSessions = 16 } = {}) =>
  sessionBytes * maxSessions + 2 * CONTROL_BYTES + MUTEX_BYTES + 1;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const REASONS = new Set(['capacity', 'corrupt', 'expired', 'clock', 'interrupted', 'refused', 'event_conflict', 'gap_conflict']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class ActivitySpool {
  constructor({ directory, sessionBytes = 8388608, maxSessions = 16, maxAgeMs = 86400000,
    now = Date.now, uptime = os.uptime, lockWaitMs = 250 } = {}) {
    if (!path.isAbsolute(directory || '') || !integer(sessionBytes, 1, 8388608) || !integer(maxSessions, 1, 16)
      || !integer(maxAgeMs, 1, 86400000) || !integer(lockWaitMs, 0, 3000)) throw new Error('invalid activity spool configuration');
    Object.assign(this, { directory, sessionBytes, maxSessions, maxAgeMs, now, uptime });
    this.store = new ActivityStorage(directory, lockWaitMs);
  }
  append(record) {
    if (!validActivityRecord(record)) return { ok: false, reason: 'invalid-record', coverage: 'unknown' };
    const line = Buffer.from(JSON.stringify(record) + '\n');
    return this.#locked(state => {
      const source = JSON.stringify(record.source);
      let slot = state.slots.find(s => s.source === source);
      if (!slot) {
        if (state.slots.length >= this.maxSessions) { this.store.unknown(); return { ok: false, reason: 'capacity', coverage: 'unknown' }; }
        const index = Array.from({ length: this.maxSessions }, (_, i) => i).find(i => !state.slots.some(s => s.index === i));
        slot = { index, id: randomUUID(), source, firstAt: this.now(), firstUptime: this.uptime(), size: 0, cursor: 0, discard: false, retired: false, loss: null };
        state.slots.push(slot);
      }
      if (slot.discard || slot.size + line.length > this.sessionBytes) {
        this.#loss(state, slot, 'capacity'); this.store.publish(state); return { ok: false, reason: 'capacity' };
      }
      state.pending = slot.id; this.store.publish(state);
      const fd = fs.openSync(this.#segment(slot), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try {
        const written = fs.writeSync(fd, line); // Exactly one O_APPEND write, including LF.
        if (written !== line.length) throw new Error('short append');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      slot.size += line.length;
      state.pending = null; this.store.publish(state);
      return { ok: true, eventId: record.event.eventId };
    });
  }
  read({ maxRecords = 128, maxBytes = 200 * 1024 } = {}) {
    if (!integer(maxRecords, 1, 128) || !integer(maxBytes, 1, 200 * 1024)) throw new Error('invalid activity read limit');
    const result = this.#locked(state => {
      for (const slot of state.slots) {
        const recovery = state.recovery?.segmentId === slot.id ? state.recovery : null;
        const records = []; let offset = slot.cursor, consumed = 0;
        const data = slot.discard || !slot.size ? Buffer.alloc(0) : fs.readFileSync(this.#segment(slot));
        const through = recovery?.end ?? data.length;
        while (!slot.discard && offset < through && records.length < maxRecords) {
          const end = data.indexOf(10, offset) + 1;
          if (!end || end > through) { this.#discard(state, slot, 'corrupt'); records.length = 0; break; }
          const line = data.subarray(offset, end);
          if (consumed + line.length > maxBytes) break;
          let record;
          try { record = JSON.parse(line.toString('utf8')); } catch {}
          if (!validActivityRecord(record) || JSON.stringify(record.source) !== slot.source) {
            this.#discard(state, slot, 'corrupt'); records.length = 0; break;
          }
          if (!recovery?.excluded.some(e => e.eventId === record.event.eventId)) records.push({ record, end });
          offset = end; consumed += line.length;
        }
        if (recovery && !slot.discard && offset !== through) return { ok: false, reason: 'recovery-read-limit', coverage: 'unknown' };
        const gaps = [...(slot.loss ? [slot.loss] : []), ...(recovery?.gaps || [])].slice(0, 32);
        if (!records.length && !gaps.length) continue;
        const segment = !slot.discard && offset > slot.cursor
          ? { id: slot.id, index: slot.index, start: slot.cursor, end: offset, digest: digest(data.subarray(0, offset)) } : null;
        const token = { rootId: state.id, generation: state.generation, slotId: slot.id, segment,
          eventIds: records.map(e => e.record.event.eventId), gapIds: gaps.map(g => g.id) };
        this.store.publish(state);
        return { ok: true, version: 1, source: JSON.parse(slot.source), records, gaps, gap: gaps[0] || null,
          generation: state.generation, coverage: this.#coverage(), token };
      }
      return { ok: true, version: 1, source: null, records: [], gaps: [], gap: null, generation: state.generation, coverage: this.#coverage(), token: null };
    });
    return result.ok ? result : { ...result, records: [], gaps: [], gap: null };
  }
  // Only call after validating a committed HTTP 200 with exact event/gap acknowledgements.
  ack(token, { committed = false, eventIds = [], gapIds = [] } = {}) {
    return this.#locked(state => {
      const slot = this.#bound(state, token);
      if (!slot || !committed || !same(eventIds, token.eventIds) || !same(gapIds, token.gapIds)) return { ok: false, reason: 'stale-ack' };
      const recovery = state.recovery?.segmentId === slot.id ? state.recovery : null;
      // Publish the committed disposition atomically. An ACK never marks other data as pending.
      if (slot.loss && gapIds.includes(slot.loss.id)) slot.loss = null;
      if (recovery) {
        for (const entry of recovery.excluded) if (gapIds.includes(entry.gapId)) entry.committed = true;
        recovery.gaps = recovery.gaps.filter(g => !gapIds.includes(g.id));
      }
      const advanced = !recovery || (!recovery.gaps.length && recovery.excluded.every(e => e.committed));
      if (advanced && token.segment) slot.cursor = token.segment.end;
      if (advanced && recovery) state.recovery = null;
      slot.retired = !slot.loss && state.recovery?.segmentId !== slot.id && (slot.discard || slot.cursor === slot.size);
      state.generation++; this.store.publish(state);
      if (slot.retired) { this.#remove(state, slot); this.store.publish(state); }
      return { ok: true, advanced };
    });
  }
  // Terminal refusal or a validated 409: persist fresh markers before excluding exactly the named IDs.
  // A 409 is NOT an ACK. Unaffected records are read again and resubmitted with their original bodies.
  resolve(token, { eventIds = [], gapIds = [], reason } = {}) {
    return this.#locked(state => {
      const slot = this.#bound(state, token);
      if (!slot || !['refused', 'event_conflict', 'gap_conflict'].includes(reason)
        || !Array.isArray(eventIds) || !Array.isArray(gapIds) || !eventIds.length && !gapIds.length
        || new Set(eventIds).size !== eventIds.length || new Set(gapIds).size !== gapIds.length
        || eventIds.some(id => !token.eventIds.includes(id)) || gapIds.some(id => !token.gapIds.includes(id))) return { ok: false, reason: 'invalid-resolution' };
      if (state.recovery && state.recovery.segmentId !== slot.id) return { ok: false, reason: 'recovery-busy' };
      const recovery = state.recovery ||= { segmentId: slot.id, end: token.segment?.end ?? slot.cursor, excluded: [], gaps: [] };
      if (recovery.excluded.length + eventIds.length > 128 || recovery.gaps.length + eventIds.length > 160) return { ok: false, reason: 'recovery-full' };
      for (const eventId of eventIds) {
        const marker = { id: randomUUID(), reason, lostCount: null };
        recovery.excluded.push({ eventId, gapId: marker.id, committed: false }); recovery.gaps.push(marker);
      }
      for (const gapId of gapIds) {
        const marker = slot.loss?.id === gapId ? slot.loss : recovery.gaps.find(g => g.id === gapId);
        if (!marker) throw new Error('missing recovery marker');
        const id = randomUUID();
        for (const entry of recovery.excluded) if (entry.gapId === gapId) entry.gapId = id;
        marker.id = id; marker.reason = 'gap_conflict';
      }
      state.generation++; this.store.publish(state);
      return { ok: true };
    });
  }

  #bound(state, token) {
    if (!token || token.rootId !== state.id || token.generation !== state.generation || !Array.isArray(token.eventIds) || !Array.isArray(token.gapIds)) return null;
    const slot = state.slots.find(s => s.id === token.slotId);
    if (!slot) return null;
    const gaps = [...(slot.loss ? [slot.loss.id] : []), ...(state.recovery?.segmentId === slot.id ? state.recovery.gaps.map(g => g.id) : [])].slice(0, 32);
    if (!same(gaps, token.gapIds)) return null;
    const receipt = token.segment;
    if (!receipt) return token.eventIds.length === 0 ? slot : null;
    if (slot.discard || receipt.id !== slot.id || receipt.index !== slot.index || receipt.start !== slot.cursor
      || !integer(receipt.end, slot.cursor + 1, slot.size)) return null;
    const data = fs.readFileSync(this.#segment(slot));
    if (data[receipt.end - 1] !== 10 || digest(data.subarray(0, receipt.end)) !== receipt.digest) return null;
    const excluded = state.recovery?.segmentId === slot.id ? state.recovery.excluded.map(e => e.eventId) : [];
    const ids = data.subarray(slot.cursor, receipt.end).toString('utf8').trimEnd().split('\n').map(l => JSON.parse(l).event.eventId).filter(id => !excluded.includes(id));
    return same(ids, token.eventIds) ? slot : null;
  }
  #coverage() { return fs.existsSync(this.store.file('uncertain')) ? 'unknown' : 'supported'; }
  #loss(state, slot, reason) {
    if (state.generation >= Number.MAX_SAFE_INTEGER) throw new Error('activity generation exhausted');
    state.generation++; slot.loss = { id: randomUUID(), reason, lostCount: null };
  }
  #discard(state, slot, reason) {
    if (slot.discard) return;
    this.#loss(state, slot, reason); slot.discard = true;
    if (state.recovery?.segmentId === slot.id) state.recovery = null;
  }
  #segment(slot) { return this.store.file(`slot-${slot.index}.jsonl`); }
  #remove(state, slot) {
    const file = this.#segment(slot);
    if (fs.existsSync(file)) { this.store.regular(file); fs.unlinkSync(file); }
    state.slots = state.slots.filter(s => s !== slot);
  }
  #maintain(state) {
    const wall = this.now(), up = this.uptime();
    const clock = wall < state.lastAt || up < state.lastUptime || Math.abs((wall - state.lastAt) - (up - state.lastUptime) * 1000) > 2000;
    for (const slot of [...state.slots]) {
      if (slot.retired) { this.#remove(state, slot); continue; }
      if (state.pending === slot.id) this.#recoverAppend(state, slot);
      if (clock || Math.abs((wall - slot.firstAt) - (up - slot.firstUptime) * 1000) > 2000) this.#discard(state, slot, 'clock');
      else if (wall - slot.firstAt >= this.maxAgeMs || (up - slot.firstUptime) * 1000 >= this.maxAgeMs) this.#discard(state, slot, 'expired');
      else if (!slot.discard && slot.size) {
        try { if (this.store.regular(this.#segment(slot)).size !== slot.size) this.#discard(state, slot, 'corrupt'); }
        catch { this.#discard(state, slot, 'corrupt'); }
      }
    }
    state.pending = null; state.lastAt = wall; state.lastUptime = up; this.store.publish(state);
  }
  #recoverAppend(state, slot) {
    // The pending write can affect only the tail after the previously committed byte count.
    // Keep the old prefix, cursor and conflict dispositions. Never re-date or regenerate them.
    try {
      const file = this.#segment(slot);
      if (fs.existsSync(file)) {
        if (this.store.regular(file).size < slot.size) throw new Error('missing committed prefix');
        const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
        try { fs.ftruncateSync(fd, slot.size); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } else if (slot.size) throw new Error('missing committed prefix');
      this.#loss(state, slot, 'interrupted');
    } catch { this.#discard(state, slot, 'corrupt'); }
  }
  #validate(state) {
    if (!same(state.policy, { sessionBytes: this.sessionBytes, maxSessions: this.maxSessions, maxAgeMs: this.maxAgeMs })) throw new Error('activity policy mismatch');
    if (state.version !== 1 || !uuid(state.id) || !integer(state.generation, 1, Number.MAX_SAFE_INTEGER - 1)
      || (state.pending !== null && !uuid(state.pending)) || !Array.isArray(state.slots) || state.slots.length > this.maxSessions
      || !Number.isFinite(state.lastAt) || !Number.isFinite(state.lastUptime)) throw new Error('invalid control');
    const indices = new Set();
    for (const s of state.slots) {
      if (!uuid(s.id) || !integer(s.index, 0, this.maxSessions - 1) || indices.has(s.index) || !integer(s.size, 0, this.sessionBytes)
        || !integer(s.cursor, 0, s.size) || typeof s.discard !== 'boolean' || typeof s.retired !== 'boolean' || !Number.isFinite(s.firstAt) || !Number.isFinite(s.firstUptime)
        || typeof s.source !== 'string' || Buffer.byteLength(s.source) > 2048 || s.loss && (!uuid(s.loss.id) || !REASONS.has(s.loss.reason))) throw new Error('invalid slot');
      indices.add(s.index);
    }
    const r = state.recovery;
    if (r && (!state.slots.some(s => s.id === r.segmentId) || !integer(r.end, 0, this.sessionBytes) || !Array.isArray(r.excluded)
      || r.excluded.length > 128 || !Array.isArray(r.gaps) || r.gaps.length > 160
      || r.excluded.some(e => !uuid(e.eventId) || !uuid(e.gapId) || typeof e.committed !== 'boolean')
      || r.gaps.some(g => !uuid(g.id) || !REASONS.has(g.reason) || g.lostCount !== null))) throw new Error('invalid recovery');
  }
  #locked(work) {
    return this.store.run(state => { this.#validate(state); this.#maintain(state); return work(state); },
      () => ({ version: 1, policy: { sessionBytes: this.sessionBytes, maxSessions: this.maxSessions, maxAgeMs: this.maxAgeMs },
        id: randomUUID(), generation: 1, pending: null, recovery: null, slots: [], lastAt: this.now(), lastUptime: this.uptime() }));
  }
}