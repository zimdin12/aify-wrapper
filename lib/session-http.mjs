// Per-session MCP over HTTP: a service is reached at its `<endpoint>/mcp/http`, as the agent the launch runs, instead of
// through a local process per session. Two kinds of service are: the launcher's own, when it is installed for http
// (aify-comms 0.9.11), and every other service that opts into every session (`sessionInject: { mcp: true }`) and
// declares `mcpTransport: "http"`.
//
// ONE HEADER SET FOR EVERY SERVICE. The launcher sends identity, placement, runtime and, separately, a key;
// the service ignores what it does not use. See docs/contracts/http-mcp.json and the original 2026-10-28 agreement
// with aify-comms and aify-dashboard (aify-dashboard docs/DESIGN-HTTP-TOOLS.md).
//
// Each service's entry bounds its key. aify-env owns the binding, custody and precedence rules.
//
// NO KEY, NO HEADER, and the entry is still written: the service is the guard, and a 401 reads as a credential
// problem where absent tools read as a broken install. A keyless aify-comms (API_KEY=) is a supported setup.
//
// THE KEY IS IN THE ENTRY. An HTTP server cannot read a credential file the way a local process does. For Claude the
// entry is a file per launch, removed when the launch exits. For Hermes it is in the user's config, where aify-comms'
// own entry already holds its key.
//
// Codex is not here: whether it sends headers, or expands variables in them, is not observed, so Codex keeps the
// local process (session-codex.mjs).

import { homedir } from "node:os";
import { resolveServiceKey, sameServiceEndpoint } from "aify-env/client/credentials";
import { HARNESS_FACTS } from "./agent-definition-schema.mjs";
import { reachedOverHttp } from "./registry.mjs";
import { OWNER, OWNER_KEY } from "./session-hermes.mjs";

//: The path a service serves its HTTP tools at, beside its endpoint.
export const MCP_HTTP_PATH = "/mcp/http";
export const MCP_HTTP_HEADERS = Object.freeze({
  agentId: "X-Aify-Agent-Id",
  machineId: "X-Aify-Machine-Id",
  launchFolder: "X-Aify-Launch-Folder",
  runtime: "X-Aify-Runtime",
  apiKey: "X-API-Key",
});

/**
 * The services a launch reaches over HTTP, as the render bakes them: the launcher's own service first when it is
 * installed for http (`own`, its name), then every other service reached over HTTP, by name. Each carries what the
 * launch needs to find its key.
 *
 * @returns {{name: string, endpoint: string, credentialRef: string, keyEnv: string[], own: boolean}[]}
 */
export function sessionHttpServices(registry, { own = "" } = {}) {
  const services = registry?.services ?? {};
  const baked = (name, isOwn) => ({
    name, endpoint: services[name]?.endpoint ?? "", credentialRef: services[name]?.credentialRef ?? "",
    keyEnv: [...(services[name]?.keyEnv ?? [])], own: isOwn,
  });
  const others = Object.keys(services).sort().filter((name) => name !== own && reachedOverHttp(services[name]));
  return [...(own ? [baked(own, true)] : []), ...others.map((name) => baked(name, false))];
}

/** The baked form: base64 of the JSON list, or "" when there is none, so the launcher can test for it. */
export function sessionHttpBase64(registry, options) {
  const services = sessionHttpServices(registry, options);
  return services.length ? Buffer.from(JSON.stringify(services), "utf8").toString("base64") : "";
}

/** The list back from its baked form. Throws on anything the render did not write, rather than guessing. */
export function sessionHttpFromBase64(text) {
  if (!text) return [];
  const services = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
  const valid = (s) => s && typeof s.name === "string" && s.name !== "" && typeof s.endpoint === "string"
    && typeof s.credentialRef === "string" && Array.isArray(s.keyEnv) && typeof s.own === "boolean";
  if (!Array.isArray(services) || !services.every(valid)) throw new Error("not a list of services this render writes");
  return services;
}

/**
 * Where a launch sends to a service: its own service at the endpoint this launch resolved (an exported endpoint
 * variable moves it, as it moves the channel), every other one at its registry endpoint.
 */
export function sessionEndpoint(service, ownEndpoint) {
  return httpBase(service.own ? ownEndpoint : service.endpoint);
}

// Cleartext loopback uses IPv4 for both authorization and transport. Keep HTTPS
// names intact because the hostname is part of certificate verification.
function httpBase(value) {
  return String(value ?? "").replace(/^(http:\/\/)localhost(?=[:/]|$)/i, "$1127.0.0.1");
}

export function sameEndpoint(a, b) {
  return sameServiceEndpoint(httpBase(a), httpBase(b));
}

/** Resolve after binding this service's entry to the exact transport base. */
export async function sessionKey(service, { url, env, home = homedir() }) {
  const result = await resolveServiceKey({ ...service, endpoint: httpBase(service.endpoint) },
    { url: httpBase(url), env, home, mode: "explicit-first" });
  return { key: result.value, refused: result.value ? "" : result.detail };
}

function urlOf(endpoint) {
  return `${httpBase(endpoint).replace(/\/+$/, "")}${MCP_HTTP_PATH}`;
}

/**
 * PURE. Claude's `mcpServers` for one launch: one HTTP server per service. The runtime id comes from the harness,
 * not the process environment.
 *
 * @param {{agentId: string, machineId: string, folder: string, keys: Record<string, string>, ownEndpoint: string}} launch
 */
export function claudeHttpServers(services, launch) {
  return Object.fromEntries(services.map((service) => [service.name, {
    type: "http",
    url: urlOf(sessionEndpoint(service, launch.ownEndpoint)),
    headers: {
      // An unnamed launch still gets an entry; the service decides which tools need a caller.
      ...(launch.agentId === "" ? {} : { [MCP_HTTP_HEADERS.agentId]: launch.agentId }),
      [MCP_HTTP_HEADERS.machineId]: launch.machineId,
      [MCP_HTTP_HEADERS.launchFolder]: launch.folder,
      [MCP_HTTP_HEADERS.runtime]: HARNESS_FACTS.claude.runtime,
      ...(launch.keys[service.name] ? { [MCP_HTTP_HEADERS.apiKey]: launch.keys[service.name] } : {}),
    },
  }]));
}

/**
 * PURE. Hermes' config entries for the other services reached over HTTP; its own service's entry is that service's
 * installer's. Hermes has one machine-wide config, so the per-launch values are Hermes' own variables:
 * `${AIFY_AGENT_ID}` from the launch's environment, and `${workspaceFolder}`, which Hermes resolves itself to the
 * session's workspace root, else its cwd (hermes-agent tools/mcp_tool_config.py `_workspace_folder`). The machine id
 * and key are facts about the machine, written as they are.
 *
 * ⛔ **A Hermes started without AIFY_AGENT_ID loses the whole server.** An unset `${VAR}` in a remote url or header
 * makes Hermes refuse it (`_require_rendered_remote` raises, read from source): it never sends the literal. So a
 * Hermes not started by hermes-aify has none of these services' tools; aify-comms' own entry makes the same trade.
 *
 * @param {{machineId: string, keys: Record<string, string>}} host
 * @returns {{ok: true, entries: {name: string, value: object}[]} | {ok: false, problems: string[]}}
 */
export function hermesHttpEntries(registry, host) {
  const services = sessionHttpServices(registry);
  const problems = services
    .filter((service) => `${host.keys[service.name] ?? ""}${host.machineId}`.includes("${"))
    .map((service) => `services.${service.name}: the key or the machine id holds "\${", which hermes would expand`);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    entries: services.map((service) => ({
      name: service.name,
      value: {
        url: urlOf(service.endpoint),
        headers: {
          [MCP_HTTP_HEADERS.agentId]: "${AIFY_AGENT_ID}",
          [MCP_HTTP_HEADERS.machineId]: host.machineId,
          [MCP_HTTP_HEADERS.launchFolder]: "${workspaceFolder}",
          [MCP_HTTP_HEADERS.runtime]: HARNESS_FACTS.hermes.runtime,
          ...(host.keys[service.name] ? { [MCP_HTTP_HEADERS.apiKey]: host.keys[service.name] } : {}),
        },
        [OWNER_KEY]: OWNER,
      },
    })),
  };
}
