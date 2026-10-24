// Post-tool state reporting, compared behaviorally with the unchanged legacy shell owner.
// Non-tool callers keep their existing shell path, including its Node-missing timestamp ladder.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function herdrToolReport({ env, firedAt }) {
  if (!env.AIFY_HERDR_AGENT) return null;
  let pane = '';
  if (env.AIFY_HERDR_PANE_FILE) {
    try {
      pane = fs.readFileSync(env.AIFY_HERDR_PANE_FILE, 'utf8').split('\n')[0];
      if (process.platform === 'win32') pane = pane.replace(/\r$/, ''); // MSYS head's text mode.
    } catch { return null; }
  } else pane = env.AIFY_HERDR_PANE_ID || env.HERDR_PANE_ID || '';
  if (!/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(pane)) return null;
  let seq = env.AIFY_HOOK_FIRED_AT || env.EPOCHREALTIME || `${firedAt}000`;
  if (/[.,]/.test(seq)) {
    const at = seq.search(/[.,]/), seconds = seq.slice(0, at), fraction = seq.slice(at + 1);
    seq = seconds + (fraction + '000000').slice(0, 6);
  }
  if (!/^[0-9]+$/.test(seq) || seq === '000000') return null;
  return { command: env.HERDR_BIN_PATH || 'herdr', args: ['pane', 'report-agent', pane, '--source', 'herdr:aify',
    '--agent', env.AIFY_HERDR_AGENT, '--state', 'working', '--seq', seq] };
}

export function reportToolWorking({ env, firedAt }) {
  try {
    const report = herdrToolReport({ env, firedAt });
    if (report) spawnSync(report.command, report.args, { env, stdio: 'ignore', timeout: 1500, windowsHide: true });
  } catch { /* The existing state route is silent and always exits zero. */ }
}
