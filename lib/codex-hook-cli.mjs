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

function nodeCommand(script) {
  if (!script || !path.isAbsolute(script) || /[\x00-\x1f"$`%!\\]/.test(script)) return null;
  return `node "${script}"`;
}

function turnStartCommand(script, env) {
  const command = nodeCommand(script);
  if (!command) return null;
  const registry = parseRegistry(readText(env.AIFY_SERVICE_REGISTRY || path.join(homedir(), ".aify", "services.json")));
  if (!registry.ok || !turnStartTargets(registry.registry).length) return null;
  return command;
}

// Comms installs this exact POSIX command for plain Codex too. Let Codex keep deciding its trust and enablement.
function commsProfileOwnsTurnStart(bridgeDir, env) {
  if (process.platform === "win32" || !bridgeDir || !path.isAbsolute(bridgeDir)) return false;
  const script = `${bridgeDir}/node_modules/aify-wrapper/bin/aify-turn-start.mjs`;
  const node = nodeCommand(script);
  if (!node) return false;
  const command = 'if [ -n "${AIFY_AGENT_ID:-}" ]; then ' + node + '; fi';
  const home = env.CODEX_HOME || path.join(homedir(), ".codex");
  try {
    const groups = JSON.parse(readText(path.join(home, "hooks.json")))?.hooks?.UserPromptSubmit;
    if (!Array.isArray(groups) || !groups.some((group) => {
      if (!Array.isArray(group?.hooks) || group.hooks.length !== 1 || Object.keys(group).length !== 1) return false;
      const [hook] = group.hooks;
      return hook?.type === "command" && hook.command === command && hook.timeout === 5 && Object.keys(hook).length === 3;
    })) return false;
    fs.accessSync(script, fs.constants.R_OK);
    return fs.statSync(script).isFile();
  } catch {
    return false;
  }
}

// A launch never depends on this helper. Return complete argv pairs for every admitted hook, or no pairs.
// The launcher consumes the notice token separately; it must not become a Codex argument.
export function codexHookLines(flags, { env, note }) {
  const value = (name) => {
    const at = flags.indexOf(name);
    return at < 0 ? null : flags[at + 1] ?? "";
  };
  // Older rendered launchers can still ask for turn-start trust by its old option name.
  const trustFile = value("--require-trust") ?? value("--require-turn-start-trust");
  const trust = trustFile === null ? null : readText(trustFile);
  const notices = [];
  let state = value("--state-script");
  if (state && trust !== null && !codexHooksTrusted(trust, state)) {
    note("codex hooks withheld: this managed launch would stop at codex's hook review, and config.toml does not trust the state hooks yet");
    // Older launchers do not know this token and would pass it in argv.
    if (flags.includes("--report-withheld-state")) notices.push("state-hooks-untrusted");
    state = null;
  }
  let context = turnStartCommand(value("--turn-start-script"), env);
  if (context && commsProfileOwnsTurnStart(value("--bridge-dir"), env)) context = null;
  if (context && trust !== null && !codexTurnStartTrusted(trust, context, Boolean(state))) {
    notices.push("turn-start-hook-untrusted");
    context = null;
  }
  return [...notices, ...codexHookArgs(state, context)];
}
