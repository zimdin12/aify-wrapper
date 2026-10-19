// Shared by the turn-start tests: a real local service, and a sealed host whose registry names it.
//
// REAL SERVERS, not a fetch double: a stall, a body that never ends and a redirect behave here as they do on the wire.

import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

export const KEY = "sekret-key-0123456789";

/** A local service: `behave(request, response, body)` decides the answer; every request is recorded. */
export async function service(t, behave) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : null });
      behave(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, seen };
}

export const answer = (text) => (request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ text, firedEventIds: [] }));
};

/** A sealed host: a home with a credential, a registry naming `endpoint`, and the runner's environment. */
export function host(t, { endpoint, credential = `${KEY}\n`, env = {}, more = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-turn-start-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".aify", "credentials"), { recursive: true });
  fs.writeFileSync(path.join(home, ".aify", "credentials", "dash.key"), credential);
  const registry = path.join(home, ".aify", "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: { dash: {
    endpoint, credentialRef: "dash.key", turnStart: { path: "/events/turn-start", budgetMs: 800 } }, ...more } }));
  const sealed = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(AIFY_|HERDR_|CLAUDE_)/i.test(name) && !["COMPUTERNAME", "HOSTNAME"].includes(name.toUpperCase())) sealed[name] = value;
  }
  return { ...sealed, HOME: home, USERPROFILE: home, AIFY_SERVICE_REGISTRY: registry, AIFY_AGENT_ID: "probe-agent",
    COMPUTERNAME: "Probe-HOST", ...env };
}
