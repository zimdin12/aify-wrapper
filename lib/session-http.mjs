// Per-session MCP over HTTP: a service is reached at its `<endpoint>/mcp/http`, as the agent the launch runs, instead of
// through a local process per session. Two kinds of service are: the launcher's own, when it is installed for http
// (aify-comms 0.9.11), and every other service that opts into every session (`sessionInject: { mcp: true }`) and
// declares `mcpTransport: "http"`.
//
// ONE HEADER SET FOR EVERY SERVICE. X-Aify-Agent-Id, X-Aify-Machine-Id, X-Aify-Launch-Folder and X-API-Key, each
// computed by one rule here; a service ignores what it does not use. Agreed with aify-comms and aify-dashboard,
// 2026-10-28 (aify-dashboard docs/DESIGN-HTTP-TOOLS.md).
//
// ONE KEY RULE, per service, from its own registry entry (sessionKey). It is aify-comms' destinationKeyResolver applied
// to each service rather than imported: comms pins this package, and comms' env step reads comms' own variable names,
// so it would hand an exported comms key to every other service. tests/the-session-key-is-resolved-as-comms-resolves-
// it.test.js holds the two equal for comms.
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

import { reachedOverHttp } from "./registry.mjs";
import { OWNER, OWNER_KEY } from "./session-hermes.mjs";

//: The path a service serves its HTTP tools at, beside its endpoint.
const HTTP_PATH = "/mcp/http";

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
  return service.own ? ownEndpoint : service.endpoint;
}

/**
 * Do two endpoints name the same service instance? As URLs, exactly as aify-comms' sameEndpoint compares them:
 * localhost is the IPv4 loopback, a missing port is the scheme's, the path is part of the service (two services behind
 * one proxy differ only by prefix), and anything unparseable equals nothing.
 */
export function sameEndpoint(a, b) {
  const norm = (value) => {
    let url;
    try {
      url = new URL(String(value || "").trim());
    } catch {
      return null;
    }
    const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${host}:${port}${url.pathname.replace(/\/+$/, "")}`;
  };
  const left = norm(a);
  return Boolean(left) && left === norm(b);
}

/**
 * The key one service's entry carries, and why there is none: `{ key, refused }`.
 *
 * A key exported under a name the service itself declared (`keyEnv`) wins, as an exported key wins in comms'
 * resolver. A service that declared none never takes an exported key, so one service's key cannot reach another's
 * header. Otherwise the credential its registry entry names (`read`, credential-file.mjs's credentialRead), and only
 * when this launch sends to the endpoint the registry names that credential for.
 */
export async function sessionKey(service, { url, env, read }) {
  const exported = service.keyEnv.map((name) => env[name]).find(Boolean);
  if (exported) return { key: exported, refused: "" };
  if (!service.credentialRef) return { key: "", refused: "the registry names no credential for it" };
  if (!sameEndpoint(service.endpoint, url)) {
    return { key: "", refused: `its credential opens ${service.endpoint || "no endpoint"}, and this launch sends to ${url}` };
  }
  return read(service.credentialRef);
}

function urlOf(endpoint) {
  return `${String(endpoint).replace(/\/+$/, "")}${HTTP_PATH}`;
}

/**
 * PURE. Claude's `mcpServers` for one launch: one http server per service, with the four headers.
 *
 * @param {{agentId: string, machineId: string, folder: string, keys: Record<string, string>, ownEndpoint: string}} launch
 */
export function claudeHttpServers(services, launch) {
  return Object.fromEntries(services.map((service) => [service.name, {
    type: "http",
    url: urlOf(sessionEndpoint(service, launch.ownEndpoint)),
    headers: {
      // A launch with no agent id still gets the tools; the service then answers reads and refuses writes.
      ...(launch.agentId === "" ? {} : { "X-Aify-Agent-Id": launch.agentId }),
      "X-Aify-Machine-Id": launch.machineId,
      "X-Aify-Launch-Folder": launch.folder,
      ...(launch.keys[service.name] ? { "X-API-Key": launch.keys[service.name] } : {}),
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
          "X-Aify-Agent-Id": "${AIFY_AGENT_ID}",
          "X-Aify-Machine-Id": host.machineId,
          "X-Aify-Launch-Folder": "${workspaceFolder}",
          ...(host.keys[service.name] ? { "X-API-Key": host.keys[service.name] } : {}),
        },
        [OWNER_KEY]: OWNER,
      },
    })),
  };
}
