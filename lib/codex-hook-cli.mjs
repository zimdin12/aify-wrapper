// File and process boundary for aify-herdr-pane's existing codex-hooks verb.
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { codexHookArgs, codexHooksTrusted, codexProfileHookTrusted, codexTurnStartTrusted } from "./codex-herdr-hooks.mjs";
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

// Comms installs this exact POSIX command for plain Codex too. Where it is, and can run: the file, its groups, the hook.
function commsProfileTurnStart(bridgeDir, env) {
  if (process.platform === "win32" || !bridgeDir || !path.isAbsolute(bridgeDir)) return null;
  const script = `${bridgeDir}/node_modules/aify-wrapper/bin/aify-turn-start.mjs`;
  const node = nodeCommand(script);
  if (!node) return null;
  const hook = { command: 'if [ -n "${AIFY_AGENT_ID:-}" ]; then ' + node + '; fi', timeout: 5 };
  const hooksFile = path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "hooks.json");
  try {
    const all = JSON.parse(readText(hooksFile))?.hooks?.UserPromptSubmit;
    const groups = (Array.isArray(all) ? all : []).flatMap((group, index) => {
      if (!Array.isArray(group?.hooks) || group.hooks.length !== 1 || Object.keys(group).length !== 1) return [];
      const [own] = group.hooks;
      return own?.type === "command" && own.command === hook.command && own.timeout === hook.timeout && Object.keys(own).length === 3 ? [index] : [];
    });
    if (!groups.length) return null;
    fs.accessSync(script, fs.constants.R_OK);
    return fs.statSync(script).isFile() ? { hooksFile, groups, hook } : null;
  } catch {
    return null;
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
  const profile = context && commsProfileTurnStart(value("--bridge-dir"), env);
  // The profile's hook stands in for ours. A launch that needs trust has nobody to grant it, and Codex skips an
  // untrusted hook in silence, so there it stands in only once config.toml trusts it.
  if (profile && (trust === null || profile.groups.some((group) => codexProfileHookTrusted(trust, profile.hooksFile, group, profile.hook)))) context = null;
  if (context && trust !== null && !codexTurnStartTrusted(trust, context, Boolean(state))) {
    notices.push("turn-start-hook-untrusted");
    context = null;
  }
  return [...notices, ...codexHookArgs(state, context)];
}
