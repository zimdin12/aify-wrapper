// File and process boundary for aify-herdr-pane's existing codex-hooks verb.
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { codexHookArgs, codexHooksTrusted, codexTurnStartTrusted } from "./codex-herdr-hooks.mjs";
import { parseRegistry } from "./registry.mjs";
import { turnStartTargets } from "./turn-start.mjs";

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function turnStartCommand(script, env) {
  if (!script || !path.isAbsolute(script) || /[\x00-\x1f"$`%!\\]/.test(script)) return null;
  const registry = parseRegistry(readText(env.AIFY_SERVICE_REGISTRY || path.join(homedir(), ".aify", "services.json")));
  if (!registry.ok || !turnStartTargets(registry.registry).length) return null;
  return `node "${script}"`;
}

// A launch never depends on this helper. Return complete argv pairs for every admitted hook, or no pairs.
// The launcher consumes the notice token separately; it must not become a Codex argument.
export function codexHookLines(flags, { env, note }) {
  const value = (name) => {
    const at = flags.indexOf(name);
    return at < 0 ? null : flags[at + 1] ?? "";
  };
  let state = value("--state-script");
  const trustFile = value("--require-trust");
  if (state && trustFile !== null && !codexHooksTrusted(readText(trustFile), state)) {
    note("codex hooks withheld: this managed resume would stop at codex's hook review, and config.toml does not trust them yet");
    state = null;
  }
  let context = turnStartCommand(value("--turn-start-script"), env);
  const contextTrust = value("--require-turn-start-trust") ?? trustFile;
  const notice = context && contextTrust !== null && !codexTurnStartTrusted(readText(contextTrust), context, Boolean(state));
  if (notice) context = null;
  return [...(notice ? ["turn-start-hook-untrusted"] : []), ...codexHookArgs(state, context)];
}
