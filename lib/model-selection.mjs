// Native /model command + completion pairs, not request models or hook callback times.
// Corpus/design: model-sync-probe/transcript-route-census-20261106.md. Parsing is deliberately shape-limited.
import fs from "node:fs";

const COMMAND = /^<command-name>\/model<\/command-name>\s*<command-message>model<\/command-message>\s*<command-args>([^<>\r\n]*)<\/command-args>$/;
const CONFIRMED = /^<local-command-stdout>Set model to `([^`\r\n]+)` and saved as your default for new sessions(?:\n[ \t]*ANTHROPIC_MODEL is set to `[^`\r\n]+` — new sessions use that while it is set)?<\/local-command-stdout>$/;
const ANSI = /\u001b\[[0-9;]*m/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PURE. Use only the launch-frozen catalog; null is an unresolved completion, not a missing event. */
export function selectionValue({ typed, display }, catalog) {
  if (!catalog || catalog.problem || !Array.isArray(catalog.rows)) return null;
  const rows = catalog.rows;
  if (!typed) {
    if (display.endsWith(" (default)")) {
      // A configured label must not impersonate the native Default suffix.
      return rows.some((r) => r.label.endsWith(" (default)")) ? null : "";
    }
    const found = rows.filter((r) => r.label === display);
    return found.length === 1 ? found[0].model : null;
  }
  const exact = rows.filter((r) => r.model === typed);
  if (exact.length) return exact.length === 1 ? exact[0].model : null;
  const labelled = rows.filter((r) => r.label === typed);
  return labelled.length === 1 ? labelled[0].model : null;
}

function nativeText(record) {
  if (!record || record.isMeta === true || record.isSidechain === true) return null;
  if (!/^2\.1\.(\d+)$/.test(record.version || "") || Number(record.version.split(".")[2]) < 273) return null;
  if (record.type === "user" && record.message?.role === "user" && typeof record.message.content === "string") return record.message.content;
  if (record.type === "system" && record.subtype === "local_command" && typeof record.content === "string") return record.content;
  return null;
}

/** PURE. A streaming parser step: callers persist pending with their native cursor, never in a report queue. */
export function modelCommandStep(pending, record, { session = "", sinceMs = 0, catalog } = {}) {
  const text = nativeText(record);
  if (text === null) return { pending, selection: null };
  const at = Date.parse(record.timestamp);
  if (!(at >= sinceMs) || !record.sessionId || (session && record.sessionId !== session)) return { pending: null, selection: null };
  const command = COMMAND.exec(text.replace(ANSI, ""));
  if (command) {
    return { pending: { typed: command[1].trim(), session: record.sessionId, type: record.type,
      promptId: record.promptId || "", uuid: record.uuid || "" }, selection: null };
  }
  const confirmed = CONFIRMED.exec(text.replace(ANSI, ""));
  const paired = pending && pending.session === record.sessionId && pending.type === record.type
    && (pending.promptId ? pending.promptId === record.promptId : pending.uuid && pending.uuid === record.parentUuid);
  if (!confirmed || !paired || typeof record.uuid !== "string" || !UUID.test(record.uuid) || CONTROL.test(confirmed[1])) return { pending: null, selection: null };
  const selection = { typed: pending.typed, display: confirmed[1], at: new Date(at).toISOString(),
    session: record.sessionId, recordUuid: record.uuid };
  if (catalog !== undefined) selection.value = selectionValue(selection, catalog);
  return { pending: null, selection };
}

/** PURE. Whole-file convenience retained for the original typed-command fixture; the producer uses native offsets. */
export function confirmedModelCommands(text, options = {}) {
  let pending = null;
  const found = [];
  for (const line of text.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const step = modelCommandStep(pending, record, options);
    pending = step.pending;
    if (step.selection) found.push(step.selection);
  }
  return found;
}

/** Legacy standalone helper. The launch-fenced producer uses continuity checks and NEVER resets to zero. */
export function readAppended(file, offset = 0, io = fs) {
  const size = io.statSync(file).size;
  const from = size < offset ? 0 : offset;
  if (size === from) return { text: "", offset: from };
  const fd = io.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    const read = io.readSync(fd, buffer, 0, buffer.length, from);
    const end = buffer.lastIndexOf(0x0a, read - 1);
    if (end < 0) return { text: "", offset: from };
    return { text: buffer.subarray(0, end + 1).toString("utf8"), offset: from + end + 1 };
  } finally { io.closeSync(fd); }
}
