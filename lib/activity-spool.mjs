// Producer only. The env shipper owns cursor, ACK, age enforcement and recovery.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validActivityRecord } from './file-activity.mjs';
import ActivityStorage from './activity-storage.mjs';
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const sourceKey = s => createHash('sha256').update(JSON.stringify([
  s.machineId, s.instanceId, s.agentId, s.incarnation, s.runtime, s.sessionId,
])).digest('hex');

export class ActivitySpool {
  constructor({ directory, sessionBytes = 8388608, maxSessions = 16, maxAgeMs = 86400000,
    now = Date.now, uptime = os.uptime } = {}) {
    if (!path.isAbsolute(directory || '') || !integer(sessionBytes, 1, 8388608) || !integer(maxSessions, 1, 16)
      || !integer(maxAgeMs, 1, 86400000) || typeof now !== 'function' || typeof uptime !== 'function') throw new Error('invalid activity spool configuration');
    this.policy = Object.freeze({ sessionBytes, maxSessions, maxAgeMs });
    Object.assign(this, { now, uptime });
    this.store = new ActivityStorage(directory);
  }
  append(record) {
    if (!validActivityRecord(record)) return { ok: false, reason: 'invalid-record', coverage: 'unknown' };
    let admitted = false, marker = 'uncertain';
    try {
      this.store.admit(); admitted = true;
      const appendedAt = { wallMs: this.now(), uptimeMs: Math.floor(this.uptime() * 1000) };
      if (!integer(appendedAt.wallMs, 0, Number.MAX_SAFE_INTEGER) || !integer(appendedAt.uptimeMs, 0, Number.MAX_SAFE_INTEGER)) throw new Error('invalid append clock');
      const line = Buffer.from(JSON.stringify({ storageVersion: 2, appendedAt, policy: this.policy, record }) + '\n');
      const segment = `session-${sourceKey(record.source)}`;
      const file = this.store.file(`${segment}.jsonl`);
      if (this.store.regular(this.store.file(`${segment}.loss`))) return this.#refused('uncertain');
      const existing = this.store.regular(file);
      if (existing) marker = `${segment}.loss`;
      if (!existing && this.store.sessionCount() >= this.policy.maxSessions) {
        this.store.mark('uncertain'); return this.#refused('capacity');
      }
      if ((existing?.size || 0) + line.length > this.policy.sessionBytes) {
        // No unbounded per-source marker if this session was never admitted.
        this.store.mark(existing ? `${segment}.loss` : 'uncertain'); return this.#refused('capacity');
      }
      return this.#appendLine({ file, segment, line, eventId: record.event.eventId });
    } catch {
      if (admitted) this.store.mark(marker);
      return this.#refused('storage');
    }
  }
  #appendLine({ file, segment, line, eventId }) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('unsafe activity segment');
      if (stat.size + line.length > this.policy.sessionBytes) {
        this.store.mark(`${segment}.loss`); return this.#refused('capacity');
      }
      // One write, no retry of a partial line, lock, control publication or fsync.
      if (fs.writeSync(fd, line) !== line.length) throw new Error('partial activity append');
      return { ok: true, eventId };
    } catch {
      this.store.mark(`${segment}.loss`); return this.#refused('storage');
    } finally { fs.closeSync(fd); }
  }
  #refused(reason) { return { ok: false, reason, coverage: 'unknown' }; }
}
