// Fixed-size control files and an OS-released cross-process mutex. No lock child or PID stealing.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export const CONTROL_BYTES = 262144;
export const MUTEX_BYTES = 32768; // 8 KiB database plus bounded rollback journal, including initialization.
export default class ActivityStorage {
  constructor(directory, lockWaitMs) { Object.assign(this, { directory, lockWaitMs }); }
  file(name) { return path.join(this.directory, name); }
  regular(file) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe activity file');
    return st;
  }
  unknown() {
    // A fixed, permanent root-wide uncertainty latch. No ACK may turn it into complete coverage.
    try { fs.writeFileSync(this.file('uncertain'), '?', { flag: 'wx', mode: 0o600 }); } catch {}
  }
  publish(state) {
    const bytes = Buffer.from(JSON.stringify(state));
    if (bytes.length > CONTROL_BYTES) throw new Error('activity control full');
    const temp = this.file('control.tmp');
    if (fs.existsSync(temp)) this.regular(temp);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      fs.writeFileSync(fd, Buffer.concat([bytes, Buffer.alloc(CONTROL_BYTES - bytes.length, 32)])); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file('control'));
  }
  admit() {
    let current = this.directory;
    for (;;) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('unsafe activity root'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^(control|control\.tmp|uncertain|mutex\.sqlite(?:-journal)?|slot-(?:[0-9]|1[0-5])\.jsonl)$/.test(name)) throw new Error('unowned activity entry');
      try {
        const st = this.regular(this.file(name));
        const bound = name.startsWith('control') ? CONTROL_BYTES : name === 'uncertain' ? 1 : name.startsWith('mutex') ? MUTEX_BYTES : 8388608;
        if (st.size > bound) throw new Error('oversize activity entry');
      } catch (e) { if (e.code !== 'ENOENT') throw e; } // Another holder can rename control.tmp.
    }
  }
  run(work, initialize) {
    let db, admitted = false;
    try {
      this.admit(); admitted = true;
      db = new DatabaseSync(this.file('mutex.sqlite'));
      db.exec(`PRAGMA busy_timeout=${this.lockWaitMs}; PRAGMA page_size=4096; PRAGMA max_page_count=2; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE`);
      // A fixed single-page table makes mutex allocation bounded. The kernel releases BEGIN on death.
      db.exec('CREATE TABLE IF NOT EXISTS mutex(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO mutex VALUES(1)');
      this.admit();
      let state;
      if (fs.existsSync(this.file('control'))) {
        if (this.regular(this.file('control')).size !== CONTROL_BYTES) throw new Error('invalid control size');
        state = JSON.parse(fs.readFileSync(this.file('control'), 'utf8'));
      } else {
        const names = fs.readdirSync(this.directory);
        if (names.some(n => !['mutex.sqlite', 'mutex.sqlite-journal', 'uncertain', 'control.tmp'].includes(n))) throw new Error('unowned activity data');
        if (names.includes('control.tmp')) this.unknown(); // An initial publish died before rename. No segment exists.
        state = initialize(); this.publish(state);
      }
      const result = work(state);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      if (admitted) this.unknown();
      return { ok: false, reason: /locked|busy/i.test(e.message) ? 'locked' : 'storage', coverage: 'unknown' };
    } finally { if (db) { try { db.close(); } catch {} } }
  }
}
