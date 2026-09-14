// The codex hooks that make a claimed pane's Herdr dot follow the agent, and whether codex would run
// them without stopping to ask.
//
// DELIVERED ON THE APP-SERVER'S COMMAND LINE, not written into ~/.codex/hooks.json. codex-aify runs
// the agent inside a `codex app-server` it starts itself, and hooks run in that process. Codex reads
// `hooks` from every config layer, including `-c` overrides (the "session flags" layer), so the hooks
// exist only for a launch that needs them and every other codex session is untouched.
//
// TRUST, measured against codex-cli 0.154.0 in an isolated CODEX_HOME rather than read and believed:
//
//   - A hook with no matching `[hooks.state."<key>"] trusted_hash` is SKIPPED by the agent loop
//     without a word (`codex exec`: the turn ran, no hook did).
//   - The TUI stops at a "hooks are new or changed" review screen before the session starts. An
//     operator answers it once; "Trust all and continue" writes the hash into config.toml.
//   - `--dangerously-bypass-hook-trust`, which codex-aify passes to managed workers, suppresses that
//     screen and runs the hooks -- EXCEPT for `resume` against a remote app-server, where the TUI
//     still shows it (`is_persistent_resume` in tui/src/lib.rs). A managed worker resuming a thread
//     would sit at that screen with nobody to answer it.
//
// So a managed resume gets these hooks only when config.toml already trusts every one of them. The
// check is offline and conservative: anything it cannot match reads as untrusted, which costs the
// dot and never the worker.

import crypto from "node:crypto";

/** [codex event, its trust-key label, the Herdr state it reports]. */
export const CODEX_STATE_EVENTS = Object.freeze([
  // A prompt, including one a delivery loop submits, starts a turn.
  ["UserPromptSubmit", "user_prompt_submit", "working"],
  // After a permission prompt is answered the next tool result is what says the turn moved on.
  ["PostToolUse", "post_tool_use", "working"],
  // Runs before codex asks a person (or its reviewer) to approve; an empty answer lets it ask.
  ["PermissionRequest", "permission_request", "blocked"],
  // The root turn finished. A thread-spawned child runs SubagentStop instead, so a subagent ending
  // does not make its parent read idle.
  ["Stop", "stop", "idle"],
  // An interrupted turn runs Interrupt and not Stop (core/src/tasks/mod.rs).
  ["Interrupt", "interrupt", "idle"],
]);

/** Interrupt and SessionEnd hooks are clamped to 3 seconds by codex, so every hook uses that. */
const TIMEOUT_SECONDS = 3;

/** The shell command codex runs for one state. Codex runs it with `$SHELL -lc`, or `cmd /C` on Windows. */
export function codexStateCommand(stateScript, state) {
  return `sh "${stateScript}" ${state}`;
}

/**
 * The `-c` arguments, flat, in order: ["-c", "hooks.UserPromptSubmit=[...]", "-c", ...].
 *
 * JSON.stringify writes a valid TOML basic string: every escape it can emit is one TOML accepts.
 */
export function codexHookArgs(stateScript) {
  const args = [];
  for (const [event, , state] of CODEX_STATE_EVENTS) {
    const command = JSON.stringify(codexStateCommand(stateScript, state));
    args.push("-c", `hooks.${event}=[{hooks=[{type="command",command=${command},timeout=${TIMEOUT_SECONDS}}]}]`);
  }
  return args;
}

/**
 * The hash codex records when an operator trusts one of these hooks.
 *
 * Codex hashes a normalized identity, not the source text (hooks/src/engine/discovery.rs `hook_hash`,
 * config/src/fingerprint.rs `version_for_toml`): sha256 over compact JSON with sorted keys. For a
 * command hook with no matcher that is exactly the object below, keys already in sorted order.
 */
export function codexHookHash(eventKey, command) {
  const identity = { event_name: eventKey, hooks: [{ async: false, command, timeout: TIMEOUT_SECONDS, type: "command" }] };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Where codex files trust for a `-c` hook. The synthetic path is resolved against `/`, or `C:\` on Windows. */
export function codexHookTrustKey(eventKey, { windows = process.platform === "win32" } = {}) {
  const source = windows ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";
  return `${source}:${eventKey}:0:0`;
}

/**
 * True when `configText` (a codex config.toml) trusts every hook `codexHookArgs(stateScript)` makes.
 *
 * Reads the table codex itself writes, `[hooks.state."<key>"]` followed by `trusted_hash = "..."`.
 * A table spelled any other way is not recognised and reads as untrusted, which is the safe answer.
 */
export function codexHooksTrusted(configText, stateScript, { windows = process.platform === "win32" } = {}) {
  const lines = String(configText || "").split(/\r?\n/);
  return CODEX_STATE_EVENTS.every(([, eventKey, state]) => {
    const key = codexHookTrustKey(eventKey, { windows });
    const headers = new Set([`[hooks.state.${JSON.stringify(key)}]`, `[hooks.state.'${key}']`]);
    const start = lines.findIndex((line) => headers.has(line.trim()));
    if (start === -1) return false;
    const want = codexHookHash(eventKey, codexStateCommand(stateScript, state));
    for (const line of lines.slice(start + 1)) {
      if (line.trim().startsWith("[")) return false;
      const match = line.match(/^\s*trusted_hash\s*=\s*"([^"]*)"\s*$/);
      if (match) return match[1] === want;
    }
    return false;
  });
}
