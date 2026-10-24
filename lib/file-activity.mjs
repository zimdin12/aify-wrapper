// Claude's explicit file_path adapter. No transcripts, shell parsing or filesystem reads.
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TOOLS = Object.freeze({ Read: 'read', Write: 'write', Edit: 'write' });
const text = (v, limit = 256) => typeof v === 'string' && v.length > 0 && v === v.trim()
  && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.byteLength(v) <= limit;
export const safeAgentId = v => text(v, 64) && /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(v)
  && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export function activityConfiguration(env) {
  const flag = env.AIFY_FILE_ACTIVITY ?? '0';
  if (!['0', '1'].includes(flag)) throw new Error('invalid activity enablement');
  const number = (key, fallback, max) => {
    const raw = env[key];
    if (raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) throw new Error('invalid activity limit');
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('invalid activity limit');
    return value;
  };
  return { enabled: flag === '1', sessionBytes: number('AIFY_ACTIVITY_SESSION_BYTES', 8 * 1024 * 1024, 8 * 1024 * 1024),
    maxSessions: number('AIFY_ACTIVITY_MAX_SESSIONS', 16, 16), maxAgeMs: number('AIFY_ACTIVITY_MAX_AGE_MS', 86400000, 86400000) };
}

export function activityEvent({ input, identity, outcome, observedAt, eventId = randomUUID() }) {
  if (!input || !identity || !safeAgentId(identity.agentId) || !text(identity.instanceId) || !text(identity.machineId)
    || (identity.incarnation !== null && !text(identity.incarnation)) || !text(input.session_id)
    || !['success', 'failure'].includes(outcome) || !Number.isSafeInteger(observedAt) || observedAt < 0) return null;
  // Child specimens are unproved. Even a present-but-empty child field is ambiguous.
  if (['agent_id', 'agent_type', 'subagent_id', 'parent_session_id', 'parent_tool_use_id'].some(k => Object.hasOwn(input, k))) return null;
  if (!Object.hasOwn(TOOLS, input.tool_name)) return null;
  const raw = input.tool_input?.file_path;
  if (!text(raw, 16384) || !text(input.cwd, 16384)) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(input.cwd);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(input.cwd) || (!windows && !input.cwd.startsWith('/'))) return null;
  if (windows && (/^[A-Za-z]:[^\\/]/.test(raw) || /^[\\/]/.test(raw))) return null;
  const canonical = paths.resolve(input.cwd, raw).replaceAll('\\', '/');
  if (!text(canonical, 16384)) return null;
  if (input.tool_use_id !== undefined && !text(input.tool_use_id)) return null;
  const record = { version: 1, adapter: 'claude-file-path-v1',
    source: { machineId: identity.machineId, instanceId: identity.instanceId, agentId: identity.agentId,
      incarnation: identity.incarnation, runtime: 'claude', sessionId: input.session_id },
    event: { eventId, tool: input.tool_name, toolCallId: input.tool_use_id ?? null, operation: TOOLS[input.tool_name],
      outcome, observedAt, path: { raw, canonical } } };
  return validActivityRecord(record) ? record : null;
}

export function validActivityRecord(r) {
  if (!exact(r, ['version', 'adapter', 'source', 'event']) || r.version !== 1 || r.adapter !== 'claude-file-path-v1') return false;
  const s = r.source, e = r.event;
  return exact(s, ['machineId', 'instanceId', 'agentId', 'incarnation', 'runtime', 'sessionId'])
    && text(s.machineId) && text(s.instanceId) && safeAgentId(s.agentId) && text(s.sessionId)
    && (s.incarnation === null || text(s.incarnation)) && s.runtime === 'claude'
    && exact(e, ['eventId', 'tool', 'toolCallId', 'operation', 'outcome', 'observedAt', 'path'])
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.eventId)
    && Object.hasOwn(TOOLS, e.tool) && e.operation === TOOLS[e.tool] && ['success', 'failure', 'unknown'].includes(e.outcome)
    && (e.toolCallId === null || text(e.toolCallId)) && Number.isSafeInteger(e.observedAt) && e.observedAt >= 0
    && exact(e.path, ['raw', 'canonical']) && text(e.path.raw, 16384) && text(e.path.canonical, 16384);
}
