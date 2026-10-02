// Hermes' half of per-session MCP: the servers opted into every session, as entries for the user's hermes config.
//
// ⛔ FOR HERMES, "EVERY SESSION" MEANS EVERY HERMES SESSION ON THE HOST, not only hermes-aify ones. Hermes has no
// per-process MCP flag. Its managed-scope overlay (HERMES_MANAGED_DIR) looked like one, but on any save it deletes a
// same-named server from the user's config and leaves a dead `<name>: {}` behind for any other name (measured on
// hermes 0.21.5, aify-dashboard docs/evidence/hermes-session-mcp-2026-10-02). So the entry is written into the user's
// config at install, like aify-comms' own, and a session no launcher gave an id passes the server the literal text
// `${AIFY_AGENT_ID}`. A service opting in must treat that as no agent.
//
// Pure, like session-codex.mjs: a parsed registry in, entries out. hermes-config-install.mjs writes them.

import { forwardingOf, isPlainKey } from "./session-codex.mjs";

//: The key every entry this installer writes carries, so it overwrites or removes only its own. Hermes keeps an unknown
//: key in an mcp_servers entry through load_config and save_config, and a server still starts with it (measured,
//: owner-mark.txt in the evidence above).
export const OWNER_KEY = "x-aify-owner";
export const OWNER = "aify-wrapper";

/**
 * The hermes config entry for every opted-in server, or the problems that stop them being written.
 *
 * Every refusal session-codex.mjs makes, because hermes forwards inherited values the same way: a server name that is
 * not a plain key (here it is a dotted path, `mcp_servers.<name>`), a variable name a shell cannot export, a forwarded
 * name any service keeps a key in, and text UTF-8 cannot carry. Plus one of hermes' own:
 *
 * ⛔ **`${` in a command or argument is refused.** Hermes expands `${...}` in args as well as env: an argument
 * `${HOME}` reached the server as `C:\Users\Administrator` (probe2.txt). An escape invented here would be a second
 * parser of hermes' grammar.
 *
 * Every forwarded name goes in `env` as `${NAME}`: hermes gives a stdio server only its safe-env allowlist plus that
 * block, so a name not listed never arrives.
 *
 * @returns {{ok: true, entries: {name: string, value: object}[]} | {ok: false, problems: string[]}}
 */
export function sessionHermesEntries(registry) {
  const services = registry?.services ?? {};
  const forwarding = forwardingOf(services);
  const entries = [];
  const problems = [];
  for (const serviceName of Object.keys(services).sort()) {
    const service = services[serviceName];
    if (service.sessionInject?.mcp !== true) continue;
    const { forwarded, problems: refused } = forwarding(serviceName, "hermes");
    problems.push(...refused);
    for (const server of service.mcp) {
      if (!isPlainKey(server.name)) {
        problems.push(`services.${serviceName}: server name ${JSON.stringify(server.name)} is not a plain key`);
        continue;
      }
      const texts = [server.command, ...server.args];
      if (texts.some((text) => !text.isWellFormed())) {
        problems.push(`services.${serviceName}: server ${server.name} has a command or argument UTF-8 cannot carry (a lone surrogate)`);
        continue;
      }
      if (texts.some((text) => text.includes("${"))) {
        problems.push(`services.${serviceName}: server ${server.name} has "\${" in its command or arguments, which hermes would expand`);
        continue;
      }
      entries.push({
        name: server.name,
        value: {
          command: server.command,
          args: [...server.args],
          env: Object.fromEntries(forwarded.map((name) => [name, `\${${name}}`])),
          [OWNER_KEY]: OWNER,
        },
      });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, entries };
}
