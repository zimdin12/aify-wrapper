// Filesystem admission and fixed one-byte uncertainty markers. No consumer state.
import fs from 'node:fs';
import path from 'node:path';
const SESSION = /^session-[0-9a-f]{64}\.jsonl$/;
const LOSS = /^session-[0-9a-f]{64}\.loss$/;
export default class ActivityStorage {
  constructor(directory) { this.directory = directory; }
  file(name) { return path.join(this.directory, name); }
  regular(file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe activity file');
    return stat;
  }
  admit() {
    // Check ancestors once per append, without walking any sibling tree or reading event bytes.
    for (let current = this.directory;;) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe activity root');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  sessionCount() {
    let count = 0;
    // Only the new-session path lists entries. Existing admitted sessions do not pay this cost.
    for (const name of fs.readdirSync(this.directory)) {
      if (!SESSION.test(name) && !LOSS.test(name) && name !== 'uncertain') throw new Error('unowned activity entry');
      const stat = this.regular(this.file(name));
      if (!stat) continue; // A cooperating consumer may retire a segment concurrently.
      if (SESSION.test(name)) count++;
      else if (stat.size !== 1) throw new Error('invalid activity marker');
    }
    return count;
  }
  mark(name) {
    // Permanent latch. Repeated losses reuse one byte; ACKs must never erase it.
    let fd;
    try {
      fd = fs.openSync(this.file(name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeSync(fd, Buffer.from('?'));
    } catch { /* Storage failure may prevent even the marker. Never claim complete coverage. */ }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  }
}
