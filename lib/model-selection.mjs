// The model a Claude session runs, as the agent's operator chose it: at launch (the --model the launcher passed, or
// none, meaning Claude's default) and after an explicit /model. aify-env compares it with its configuration and
// writes the change back (model sync #23); nothing here changes a model.
//
// A /MODEL IS CONFIRMED BY CLAUDE'S OWN PAIR OF RECORDS in the transcript: a user record holding
// `<command-name>/model</command-name>` and `<command-args>X</command-args>`, then one with the same promptId holding
// `<local-command-stdout>Set model to \`D\` ...`. Claude writes them only after its "Switch model?" dialog is answered
// Yes (model-sync probe, 2026-11-02: transcript d89411ae lines 54-55 for a bare id, 82-83 for an alias). A command
// without that stdout -- answered No, or failed -- is no selection.
//
// A BARE /MODEL RUNS NO STOP HOOK: in the same transcript the next stop_hook_summary after line 55 is line 77, after
// the next prompt's reply. So a /model reaches aify-env at the next turn end, or at SessionEnd.

import fs from "node:fs";

const COMMAND = /^<command-name>\/model<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const CONFIRMED = /^<local-command-stdout>Set model to `([^`]+)`/;
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * PURE. Every confirmed /model in `text` (whole JSONL lines), in order, made at or after `sinceMs`: the selector as typed,
 * the name Claude displayed, when, and in which session. A record before `sinceMs` belongs to an earlier launch of a
 * resumed session, whose choice that launch has already replaced.
 */
export function confirmedModelCommands(text, { sinceMs = 0 } = {}) {
  const pending = new Map();
  const found = [];
  for (const line of text.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const content = record?.type === "user" && typeof record.message?.content === "string" ? record.message.content : null;
    if (content === null || typeof record.promptId !== "string") continue;
    const at = Date.parse(record.timestamp);
    if (!(at >= sinceMs)) continue;
    if (COMMAND.test(content)) {
      const typed = ARGS.exec(content)?.[1].trim() ?? "";
      if (typed) pending.set(record.promptId, typed);
      continue;
    }
    const confirmed = CONFIRMED.exec(content.replace(ANSI, ""));
    if (confirmed && pending.has(record.promptId)) {
      found.push({ typed: pending.get(record.promptId), display: confirmed[1], at: new Date(at).toISOString(), session: record.sessionId ?? "" });
      pending.delete(record.promptId);
    }
  }
  return found;
}

/**
 * The whole lines appended to `file` since byte `offset`, and the offset after the last of them; a line still being
 * written is left for the next read. A file shorter than `offset` was replaced, so it is read from the start.
 */
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
  } finally {
    io.closeSync(fd);
  }
}
