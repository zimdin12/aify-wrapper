// Native profile paths and the service-owned pin helper's controlled reply. No credential or registry writer.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PURE. Inputs are the parser's facts and the post-hygiene incoming frame, before identity/mode export. */
export function pinnedResumeEligible({ explicit, selector, fresh, shared, resumeId, agentId, env } = {}) {
  if (explicit !== true || selector !== false || fresh !== false || shared !== false || resumeId !== ""
    || typeof agentId !== "string" || !agentId || !env || typeof env !== "object") return false;
  if (typeof env.AIFY_SESSION_HANDLE === "string" && env.AIFY_SESSION_HANDLE) return false;
  return !(env.AIFY_AGENT_ID === agentId && env.AIFY_SESSION_MODE === "managed" && env.AIFY_MANAGED_VIA_WRAPPER === "1");
}

/** PURE. The caller supplies its resolved native home, not an unrelated shell's profile default. */
export function claudeConfigRoot({ env = {}, home }) {
  if (env.CLAUDE_CONFIG_DIR) {
    if (typeof env.CLAUDE_CONFIG_DIR !== "string") throw new Error("selected Claude profile is not a path");
    return env.CLAUDE_CONFIG_DIR;
  }
  if (typeof home !== "string" || !home) throw new Error("no native Claude home was supplied");
  return path.join(home, ".claude");
}

/** One selected profile's transcript namespace; metadata only, never a latest-session guess. */
export class ClaudeTranscripts {
  constructor({ env = {}, home }) { this.projects = path.resolve(claudeConfigRoot({ env, home }), "projects"); }
  find(session) {
    if (typeof session !== "string" || !session || session === "." || session === ".." || /[/\\\u0000-\u001f]/.test(session)) return null;
    try {
      for (const entry of fs.readdirSync(this.projects, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(this.projects, entry.name, `${session}.jsonl`);
        try { if (fs.lstatSync(file).isFile()) return file; } catch { /* Not in this project. */ }
      }
    } catch { /* An unavailable profile cannot attest a transcript. */ }
    return null;
  }
}

/** PURE. Exactly one controlled line; a body or diagnostic from a server is never a session selector. */
export function parsePinReply(reply) {
  const unavailable = { status: "unavailable", session: "" };
  if (typeof reply !== "string") return unavailable;
  const text = reply.endsWith("\r\n") ? reply.slice(0, -2) : reply.endsWith("\n") ? reply.slice(0, -1) : reply;
  if (["none", "wrong-runtime", "unavailable"].includes(text)) return { status: text, session: "" };
  const parts = text.split("\t");
  if (parts.length !== 2 || parts[0] !== "found" || /[\u0000-\u001f\u007f]/.test(parts[1]) || !UUID.test(parts[1])) return unavailable;
  return { status: "found", session: parts[1] };
}

/** Executes only the installed service helper; the bridge owns its credential source and HTTP API. */
export class ClaudePinLookup {
  constructor({ bridge, endpoint, agentId, env, home, run = spawnSync }) {
    this.helper = typeof bridge === "string" && bridge ? path.join(bridge, "session-for-agent.mjs") : "";
    this.endpoint = endpoint; this.agentId = agentId; this.env = env;
    this.transcripts = new ClaudeTranscripts({ env, home }); this.run = run;
  }
  lookup() {
    if (!this.env || typeof this.endpoint !== "string" || !this.endpoint || typeof this.agentId !== "string" || !this.agentId
      || !fs.existsSync(this.helper)) return { status: "unavailable", session: "" };
    try {
      const result = this.run(process.execPath, [this.helper, this.endpoint, "claude-code", this.agentId], {
        env: this.env, encoding: "utf8", input: "", shell: false, windowsHide: true, timeout: 3000, maxBuffer: 4096,
      });
      if (result.status !== 0 || result.error) return { status: "unavailable", session: "" };
      const selected = parsePinReply(result.stdout);
      if (selected.status !== "found") return selected;
      return this.transcripts.find(selected.session) ? selected : { status: "missing-transcript", session: "" };
    } catch { return { status: "unavailable", session: "" }; }
  }
}
