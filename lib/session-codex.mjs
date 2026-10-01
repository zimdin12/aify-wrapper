// Codex's half of per-session MCP: the servers opted into every session, as `-c` words for `codex app-server`.
//
// Kept beside registry.mjs rather than in it: that file parses the registry, and this renders one runtime's
// view of it. Pure, like the parser: a parsed registry in, words out, no filesystem and no environment.
//
// The app-server, because it owns the session and the TUI only attaches to it. `env_vars`, because codex
// passes an MCP server no variable it is not told to: measured on codex 0.159.3, 2026-10-01, a server added
// without it saw AIFY_AGENT_ID as null (aify-dashboard docs/evidence/codex-session-mcp-2026-10-01).

import { Buffer } from "node:buffer";

//: The variable every opted-in server is given, whatever its entry says: the bridge's identity.
const FORWARDED = ["AIFY_AGENT_ID"];

//: A TOML bare key. A server name outside it would be read as a nested key (a dot) or not parse at all.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
//: A variable name a shell can export. Anything else forwards nothing and hides that it does.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A TOML basic string. Quote and backslash escaped, every control byte as \uXXXX, so nothing ends it early. */
export function tomlString(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === '"' || char === "\\") out += `\\${char}`;
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `"${out}"`;
}

/**
 * The `-c` words for every opted-in server, or the problems that stop them being written.
 *
 * Refuses rather than repairs: a server name or a variable name that is not plain is a registry mistake, and an
 * install that quietly skipped it would launch agents without the server and say nothing.
 *
 * ⛔ **A forwarded name that ANY service keeps a key in is refused.** codex forwards a variable's inherited VALUE, and
 * the parser's keyEnv refusal is per service: an opted-in entry with no key of its own could still list, in
 * endpointEnv, the variable a neighbour keeps its credential in (the senior reviewer's C1, 2026-10-01). So the check
 * is over the whole registry.
 *
 * ⛔ **A command or argument UTF-8 cannot carry is refused.** A lone surrogate parses as JSON and would become U+FFFD
 * in the base64, so codex would be handed a different path with exit 0 (the reviewer's C2).
 *
 * @returns {{ok: true, words: string[]} | {ok: false, problems: string[]}}
 */
export function sessionCodexWords(registry) {
  const services = registry?.services ?? {};
  const words = [];
  const problems = [];
  // Every variable some service keeps a key in, and which services, across the whole registry. KEYED CASE-FOLDED: a
  // native Windows environment folds case, so `a_key` and `A_KEY` are one variable there (the reviewer's C3). Folded
  // on every platform, which refuses a little more than Linux needs and never less than Windows does.
  const keyHolders = new Map();
  for (const name of Object.keys(services).sort()) {
    for (const variable of services[name].keyEnv ?? []) {
      const folded = variable.toUpperCase();
      keyHolders.set(folded, [...(keyHolders.get(folded) ?? []), name]);
    }
  }
  for (const serviceName of Object.keys(services).sort()) {
    const service = services[serviceName];
    if (service.sessionInject?.mcp !== true) continue;
    const forwarded = [...FORWARDED, ...service.endpointEnv];
    for (const name of forwarded.filter((n) => !ENV_NAME.test(n))) {
      problems.push(`services.${serviceName}: ${JSON.stringify(name)} is not a variable name codex can forward`);
    }
    for (const name of forwarded.filter((n) => keyHolders.has(n.toUpperCase()))) {
      problems.push(`services.${serviceName}: ${JSON.stringify(name)} would be forwarded, and ${keyHolders.get(name.toUpperCase()).join(", ")} keeps a key in it, in some spelling`);
    }
    for (const server of service.mcp) {
      if (!BARE_KEY.test(server.name)) {
        problems.push(`services.${serviceName}: server name ${JSON.stringify(server.name)} is not a plain TOML key`);
        continue;
      }
      const unsendable = [server.command, ...server.args].filter((text) => !text.isWellFormed());
      if (unsendable.length) {
        problems.push(`services.${serviceName}: server ${server.name} has a command or argument UTF-8 cannot carry (a lone surrogate)`);
        continue;
      }
      const key = `mcp_servers.${server.name}`;
      words.push(
        "-c", `${key}.command=${tomlString(server.command)}`,
        "-c", `${key}.args=[${server.args.map(tomlString).join(", ")}]`,
        "-c", `${key}.env_vars=[${forwarded.map(tomlString).join(", ")}]`,
      );
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, words };
}

/**
 * Those words, each terminated by a NUL, in base64; "" when nothing opted in.
 *
 * TERMINATED, not separated: the launcher reads them with `read -r -d ''`, which drops a last word that has no
 * NUL after it. Base64 for the reason the claude fragment gives, so no word is ever parsed as shell.
 *
 * @returns {{ok: true, value: string} | {ok: false, problems: string[]}}
 */
export function sessionCodexWordsBase64(registry) {
  const result = sessionCodexWords(registry);
  if (!result.ok) return result;
  if (result.words.length === 0) return { ok: true, value: "" };
  return { ok: true, value: Buffer.from(result.words.map((word) => `${word}\0`).join(""), "utf8").toString("base64") };
}
