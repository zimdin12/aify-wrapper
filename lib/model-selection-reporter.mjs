// One launch's explicit-choice producer. Cursor metadata is not a retry queue or a definition writer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { idProblems } from "./agent-definition-schema.mjs";
import { AgentLease, leaseDirectory } from "./agent-lease.mjs";
import { FileLock } from "./file-lock.mjs";
import { sessionFolder, sessionsRoot, writeSessionFileSync } from "./session-folder.mjs";
import { readModelCatalog, hasForwardedSettings } from "./model-catalog.mjs";
import { TranscriptCursor } from "./model-transcript-cursor.mjs";
import { modelEnvelopeValid, postModelSelection } from "./model-selection-post.mjs";
import { ClaudeTranscripts } from "./claude-sessions.mjs";

const STATE = "model-selection.json";
const TRIGGERS = new Set(["SessionStart", "UserPromptSubmit", "Stop", "PostModelSwitch", "SessionEnd"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PURE. Original explicit launch choice only, never a definition/default the wrapper added afterwards. */
export function explicitLaunchModel(argv) {
  let value = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") { const next = argv[++i]; value = typeof next === "string" && !next.startsWith("-") ? next : null; }
    else if (argv[i].startsWith("--model=")) value = argv[i].slice("--model=".length);
  }
  return value;
}

// Resolve existing ancestors without creating directories. A later symlink/path change cannot rebind this target.
function canonicalTarget(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    const parent = path.dirname(file);
    if (error.code !== "ENOENT" || parent === file) throw error;
    return path.join(canonicalTarget(parent), path.basename(file));
  }
}

export class ModelSelectionReporter {
  constructor(options = {}) {
    this.env = { ...(options.env || process.env) };
    this.home = options.home || (process.platform === "win32" ? this.env.USERPROFILE : this.env.HOME) || os.homedir();
    this.agent = this.env.AIFY_AGENT_ID || "";
    this.instance = this.env.AIFY_ENV_INSTANCE || "";
    this.lifetime = this.env.AIFY_LIFETIME || "";
    this.pid = Number(this.env.AIFY_AGENT_LEASE);
    this.dir = path.join(sessionsRoot(this.home), this.agent);
    this.file = path.join(this.dir, STATE);
    this.owns = options.owns || (() => new AgentLease({ agentId: this.agent, directory: leaseDirectory({ env: this.env, home: this.home }) }).holds(this.pid));
    this.folder = options.folder || (() => sessionFolder({ agentId: this.agent, launcherPid: this.pid, home: this.home, env: this.env }));
    this.log = options.log || ((line) => process.stderr.write(`[claude-aify] ${line}\n`));
    this.fetchImpl = options.fetchImpl || fetch;
    this.catalogOptions = Object.hasOwn(options, "managed") ? { managed: options.managed } : {};
  }

  #admitted() {
    return idProblems(this.agent).length === 0 && Number.isSafeInteger(this.pid) && this.pid > 0
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.instance) && UUID.test(this.lifetime) && this.owns();
  }
  #belongs(state) {
    return state?.version === 1 && state.agent === this.agent && state.instance === this.instance && state.lifetime === this.lifetime && state.pid === this.pid;
  }
  #read() {
    try { if (!fs.lstatSync(this.file).isFile()) return null; return JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { return null; }
  }
  #locked(work) {
    return new FileLock({ path: `${this.file}.lock`, waitMs: 300, staleMs: Infinity, unreadableMs: Infinity }).hold(work);
  }
  #write(state, stillHeld) {
    if (!stillHeld() || !this.#admitted()) throw new Error("model cursor ownership changed before write");
    writeSessionFileSync(this.dir, STATE, JSON.stringify(state) + "\n");
  }
  #envelope(source, position, value) {
    return { instance: this.instance, lifetime: this.lifetime, harness: "claude", source, ...position, value };
  }
  async #post(body) {
    if (!this.#admitted()) return false;
    const posted = await postModelSelection(this.agent, body, { env: this.env, home: this.home, fetchImpl: this.fetchImpl });
    if (!posted) this.log(`model selection ${body.source} report failed; not queued or replayed`);
    return posted;
  }
  #transcripts() { return new ClaudeTranscripts({ env: this.env, home: this.home }); }
  #projects() { return this.#transcripts().projects; }
  #resumeFile(session) { return UUID.test(session) ? this.#transcripts().find(session) : null; }
  #nativePath(payload) {
    if (!UUID.test(payload.session_id || "") || typeof payload.transcript_path !== "string") return null;
    try {
      const supplied = path.resolve(payload.transcript_path);
      try { if (!fs.lstatSync(supplied).isFile()) return null; }
      catch (error) { if (error.code !== "ENOENT") return null; }
      const file = canonicalTarget(supplied), root = canonicalTarget(this.#projects());
      const relative = path.relative(root, file);
      return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && path.basename(file) === `${payload.session_id}.jsonl` ? file : null;
    } catch { return null; }
  }

  async initialize({ claimedAgent, resumeId = "", ownSettings, argv = [] }) {
    if (claimedAgent !== this.agent || !this.#admitted()) return { ready: false, problem: "no matching claimed launch" };
    const folder = await this.folder();
    if (!folder.ok || path.resolve(folder.dir) !== path.resolve(this.dir)) return { ready: false, problem: folder.problem || "unexpected model cursor folder" };
    let disabled = hasForwardedSettings(argv) ? "forwarded --settings can replace our hooks" : argv.includes("--fork-session") ? "fork-session is not qualified" : "";
    const catalog = disabled ? { rows: [], problem: disabled } : readModelCatalog({ ...this.catalogOptions, env: this.env, home: this.home, ownSettings, argv });
    let cursor = null;
    if (!disabled && resumeId) {
      const file = this.#resumeFile(resumeId);
      const captured = file ? TranscriptCursor.capture({ file, session: resumeId }) : { problem: "resume transcript unavailable for prelaunch fence" };
      if (captured.problem) disabled = captured.problem;
      else cursor = captured.state;
    }
    const fresh = !resumeId && !argv.some((arg) => /^(?:--(?:resume|continue|session-id|fork-session)(?:=|$)|-[rc])/.test(arg));
    const state = { version: 1, agent: this.agent, instance: this.instance, lifetime: this.lifetime, pid: this.pid, catalog, disabled, blocked: false, fresh, cursor };
    const body = this.#envelope("launch", { session: "", transcriptIdentity: null, endOffset: null, recordUuid: null }, explicitLaunchModel(argv));
    try {
      this.#locked((stillHeld) => this.#write(state, stillHeld));
      if (disabled) this.log(`model-command reporting disabled: ${disabled}; explicit launch report retained`);
      else if (catalog.problem) this.log(`model-command values unresolved: ${catalog.problem}`);
      await this.#post(body);
      return { ready: true, problem: "" };
    } catch (error) { return { ready: false, problem: error.code || error.message }; }
  }

  async hook(payload) {
    if (!TRIGGERS.has(payload?.hook_event_name) || !this.#admitted()) return { posted: false };
    const known = this.#read();
    if (!this.#belongs(known) || known.disabled || known.blocked) return { posted: false };
    const folder = await this.folder();
    if (!folder.ok || path.resolve(folder.dir) !== path.resolve(this.dir)) return { posted: false, problem: folder.problem || "unexpected model cursor folder" };
    let body = null;
    try {
      this.#locked((stillHeld) => {
        const state = this.#read();
        if (!this.#belongs(state) || state.disabled || state.blocked || !this.#admitted()) return;
        const file = this.#nativePath(payload);
        const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
        if (!file || (state.cursor && (payload.session_id !== state.cursor.session || !samePath(file, canonicalTarget(state.cursor.file))))) {
          this.#write({ ...state, blocked: true }, stillHeld); return;
        }
        if (!state.cursor) {
          if (payload.hook_event_name !== "SessionStart" || !["startup", "resume"].includes(payload.source)) return;
          const captured = TranscriptCursor.capture({ file, session: payload.session_id, allowMissing: state.fresh === true && payload.source === "startup" });
          if (captured.problem) throw new Error(captured.problem);
          this.#write({ ...state, cursor: captured.state }, stillHeld); return;
        }
        const scanned = new TranscriptCursor(state.cursor).scan({ catalog: state.catalog });
        if (scanned.problem) throw new Error(scanned.problem);
        this.#write({ ...state, cursor: scanned.state }, stillHeld);
        if (scanned.selection) {
          const { session, transcriptIdentity, endOffset, recordUuid, value } = scanned.selection;
          body = this.#envelope("model-command", { session, transcriptIdentity, endOffset, recordUuid }, value);
          if (!modelEnvelopeValid(body)) throw new Error("native completion produced an invalid report");
        }
      });
      return { posted: body ? await this.#post(body) : false };
    } catch (error) {
      this.log(`model-command scan refused: ${error.code || error.message}`);
      return { posted: false, problem: error.code || error.message };
    }
  }

  async finish() {
    if (!this.#admitted()) return { posted: false };
    const state = this.#read();
    if (!this.#belongs(state) || !state.cursor) return { posted: false };
    return this.hook({ hook_event_name: "SessionEnd", session_id: state.cursor.session, transcript_path: state.cursor.file });
  }
}
