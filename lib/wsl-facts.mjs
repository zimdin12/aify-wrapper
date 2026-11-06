// Behavioral twin of dashboard bridge/wsl-facts.ts and locations/wsl.ts; contract specimens pin both.
const FILES = Object.freeze({ release: '/proc/sys/kernel/osrelease', identity: '/etc/machine-id', mounts: '/proc/mounts' });

/** Calculation over one explicit snapshot reader; no environment variables or mount-name inference. */
export function collectWslFacts(read) {
  const release = read(FILES.release);
  if (release === null || !/microsoft/i.test(release)) return null;
  const identity = read(FILES.identity);
  return { distroId: identity === null || identity.trim() === '' ? null : identity.trim(), driveMounts: parseProcMounts(read(FILES.mounts) ?? '') };
}

function parseProcMounts(text) {
  const mounts = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [, rawMountPoint, type, options] = fields;
    if (type !== '9p' && type !== 'drvfs') continue;
    if (!/(^|;|,)aname=drvfs(;|,|$)/.test(options)) continue;
    const declared = /(?:^|[;,])path=([A-Za-z]):\\(?:[;,]|$)/.exec(options);
    if (declared === null) continue;
    const mountPoint = rawMountPoint.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
    mounts.push({ mountPoint, drive: declared[1].toUpperCase() });
  }
  return mounts;
}

/** Owns the native platform/reader boundary; the caller retains its existing overall deadline. */
export class WslFactsReader {
  constructor({ platform, readFile } = {}) { this.platform = platform; this.readFile = readFile; }
  async read() {
    if (this.platform !== 'linux' || typeof this.readFile !== 'function') return null;
    const entries = await Promise.all(Object.values(FILES).map(async file => {
      try {
        const value = await this.readFile(file, 'utf8');
        return [file, typeof value === 'string' ? value : null];
      } catch { return [file, null]; }
    }));
    const snapshot = new Map(entries);
    return collectWslFacts(file => snapshot.get(file) ?? null);
  }
}
