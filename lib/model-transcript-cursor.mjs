// A launch-fenced native transcript stream. A discontinuity never resets/replays old choices.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { modelCommandStep } from "./model-selection.mjs";

const ANCHOR_BYTES = 256;
const MAX_APPEND_BYTES = 64 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readBytes(fd, from, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const count = fs.readSync(fd, bytes, done, length - done, from + done);
    if (!count) throw new Error("transcript became shorter while reading");
    done += count;
  }
  return bytes;
}
function anchor(fd, offset) {
  const length = Math.min(offset, ANCHOR_BYTES);
  return digest(readBytes(fd, offset - length, length));
}
function openTranscript(file, session) {
  if (typeof file !== "string" || !session || path.basename(file) !== `${session}.jsonl` || !fs.lstatSync(file).isFile()) throw new Error("not a regular native-session transcript");
  const canonical = fs.realpathSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const linked = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || !linked.isFile() || stat.dev !== linked.dev || stat.ino !== linked.ino || !stat.ino) throw new Error("native file identity cannot be established");
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("unsafe transcript size");
    const identity = digest(JSON.stringify([canonical, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]));
    return { fd, size, identity };
  } catch (error) { fs.closeSync(fd); throw error; }
}
const failed = (state, error) => ({ state, selection: null, problem: `transcript continuity refused (${error.code || error.message})` });

export class TranscriptCursor {
  constructor(state) { this.state = structuredClone(state); }

  /** Capture before resume, or in synchronous native SessionStart before the first operator command. */
  static capture({ file, session, allowMissing = false }) {
    let opened;
    try {
      opened = openTranscript(file, session);
      const { fd, size, identity } = opened;
      return { problem: "", state: { file: path.resolve(file), session, identity, fence: size, offset: size,
        anchor: anchor(fd, size), skipPartial: size > 0 && readBytes(fd, size - 1, 1)[0] !== 10, pending: null } };
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return { problem: "", state: { file: path.resolve(file), session, identity: null, fence: 0, offset: 0,
        anchor: digest(Buffer.alloc(0)), skipPartial: false, pending: null, awaitingCreation: true } };
      return { state: null, problem: failed(null, error).problem };
    }
    finally { if (opened) fs.closeSync(opened.fd); }
  }

  /** Returns new cursor state explicitly; no caller state mutation and no network effects under a file lock. */
  scan({ catalog }) {
    const state = this.state;
    let opened;
    try {
      if (!state || !Number.isSafeInteger(state.offset) || !Number.isSafeInteger(state.fence) || state.offset < state.fence || state.fence < 0) throw new Error("invalid cursor");
      opened = openTranscript(state.file, state.session);
      const { fd, size, identity } = opened;
      const waiting = state.awaitingCreation === true && state.identity === null && state.fence === 0 && state.offset === 0;
      if ((!waiting && identity !== state.identity) || size < state.offset || anchor(fd, state.offset) !== state.anchor) throw new Error("native file replaced, truncated or rewritten");
      if (size - state.offset > MAX_APPEND_BYTES) throw new Error("unscanned transcript exceeds bounded read");
      const bytes = readBytes(fd, state.offset, size - state.offset);
      let start = 0, consumed = 0, pending = state.pending, skipPartial = state.skipPartial, latest = null;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        consumed = end + 1;
        if (skipPartial) { skipPartial = false; pending = null; }
        else {
          let record;
          try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end))); }
          catch { pending = null; start = consumed; continue; }
          const step = modelCommandStep(pending, record, { catalog, session: state.session });
          pending = step.pending;
          if (step.selection) latest = { ...step.selection, transcriptIdentity: identity, endOffset: state.offset + consumed };
        }
        start = consumed;
      }
      const offset = state.offset + consumed;
      // Check the original read boundary as well as the last consumed line before publishing a new cursor.
      if (fs.fstatSync(fd).size < size || anchor(fd, state.offset) !== state.anchor) throw new Error("transcript changed while scanning");
      return { problem: "", selection: latest, state: { ...state, identity, awaitingCreation: false, offset, anchor: anchor(fd, offset), pending, skipPartial } };
    } catch (error) {
      if (state?.awaitingCreation === true && state.identity === null && state.fence === 0 && state.offset === 0 && error.code === "ENOENT") return { problem: "", state, selection: null };
      return failed(state, error);
    }
    finally { if (opened) fs.closeSync(opened.fd); }
  }
}
