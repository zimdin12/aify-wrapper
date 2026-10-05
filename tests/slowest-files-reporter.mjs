// A node:test reporter that prints the run's slowest files, so a slow file in the fast tier shows on every run
// instead of being found by a stopwatch weeks later. The fast tier is `npm test`; a file that renders a launcher
// or starts real processes belongs in the release tier (`*.release.test.js`, `npm run test:release`).
import path from "node:path";

const SHOWN = 10;

export default async function* slowestFiles(source) {
  const files = new Map();
  for await (const { type, data } of source) {
    if ((type !== "test:pass" && type !== "test:fail") || data.nesting !== 0 || !data.file) continue;
    const f = files.get(data.file) ?? { ms: 0, n: 0 };
    f.ms += data.details?.duration_ms ?? 0;
    f.n += 1;
    files.set(data.file, f);
  }
  const rows = [...files.entries()].sort((a, b) => b[1].ms - a[1].ms);
  const summed = rows.reduce((s, [, f]) => s + f.ms, 0);
  yield `\n# ${rows.length} files, ${(summed / 1000).toFixed(0)} s summed. The ${Math.min(SHOWN, rows.length)} slowest:\n`;
  for (const [file, f] of rows.slice(0, SHOWN)) {
    yield `# ${(f.ms / 1000).toFixed(1).padStart(7)} s ${String(f.n).padStart(3)} tests  ${path.basename(file)}\n`;
  }
}
