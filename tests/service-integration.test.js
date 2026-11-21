// The service side takes its spec, connect example and HTTP fixture from the public guide.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KEY, makeHost, runConnect } from "./connect-fixture.mjs";

const guide = new URL("../docs/SERVICE-INTEGRATION.md", import.meta.url);
const AGENT = "example-caller";
const HOST = "example-host";

function exampleFromGuide() {
  const text = fs.readFileSync(guide, "utf8");
  const spec = JSON.parse(text.match(/^```json\r?\n([\s\S]+?)^```/m)?.[1]);
  const fixture = text.match(/\]\((contracts\/[^)]+\.json)\)/)?.[1];
  assert.ok(fixture, "the guide must name the packaged HTTP fixture");
  const wire = JSON.parse(fs.readFileSync(new URL(fixture, guide), "utf8"));
  const command = text.match(/^aify-wrapper-connect (\S+) (\S+) (--key-file) (\S+)\r?$/m);
  assert.ok(command, "the guide must give a connect command with a key file");
  const [, name, endpoint, flag, keyFile] = command;
  return { spec, wire, name, endpoint, flag, keyFile };
}

async function serveExample(t, { spec, wire, endpoint }) {
  const probe = spec.verify.probes[spec.secrets[0].probe];
  const names = Object.fromEntries(Object.entries(wire.headers).map(([key, header]) => [key, header.toLowerCase()]));
  const prefix = new URL(endpoint).pathname.replace(/\/$/, "");
  const tool = { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
  const server = http.createServer(async (req, res) => {
    const send = (status, data = {}) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.method === "GET" && req.url === `${prefix}/.well-known/aify-service`) return send(200, spec);
    if (req.method === "GET" && req.url === `${prefix}${spec.verify.health.path}`) return send(200);
    if (req.method === "GET" && req.url === `${prefix}${probe.path}`) return send(req.headers[probe.header.toLowerCase()] === KEY ? 200 : 401);
    if (req.method !== "POST" || req.url !== `${prefix}${wire.path}`) return send(404);
    if (req.headers[names.apiKey] !== KEY) return send(401);
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    const result = (value) => send(200, { jsonrpc: "2.0", id, result: value });
    if (method === "notifications/initialized" && id === undefined) return res.writeHead(202).end();
    if (method === "initialize") return result({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: spec.name, version: spec.version } });
    if (method === "tools/list") return result({ tools: [tool] });
    if (method === "tools/call" && params.name === tool.name) {
      if (!req.headers[names.agentId]) return send(400, { problem: "missing caller header" });
      return result({ content: [{ type: "text", text: params.arguments.text }], structuredContent: {
        caller: req.headers[names.agentId], machine: req.headers[names.machineId], folder: req.headers[names.launchFolder],
      } });
    }
    return send(400);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}${prefix}`;
}

function nodeOutput(relative, args, env) {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(relative, import.meta.url)), ...args], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return run.stdout.trim();
}

function installedEntries(host, name) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AIFY_|HERDR_|HERMES_)/i.test(key)));
  const env = { ...base, HOME: host.home, USERPROFILE: host.home, APPDATA: host.home, LOCALAPPDATA: host.home,
    AIFY_AGENT_ID: AGENT, AIFY_MACHINE_ID: HOST, AIFY_SERVICE_REGISTRY: host.registry };
  const baked = nodeOutput("../lib/registry-cli.mjs", ["session-http-b64", host.registry], env);
  assert.ok(baked, "the guide's spec must opt in to HTTP tools");
  const config = nodeOutput("../bin/aify-session-mcp.mjs", [], { ...env, AIFY_SESSION_HTTP_B64: baked });
  const claude = JSON.parse(fs.readFileSync(config, "utf8")).mcpServers[name];
  assert.equal(claude?.type, "http");

  const state = path.join(host.home, "hermes-state.json");
  fs.writeFileSync(state, "{}");
  nodeOutput("../lib/hermes-config-cli.mjs", ["--write-now", host.registry], {
    ...env, HERMES_HOME: path.join(host.home, "hermes"), HERMES_RUNTIME_COMMAND: fileURLToPath(new URL("./fake-hermes.mjs", import.meta.url)),
    FAKE_HERMES_STATE: state, FAKE_HERMES_LOG: path.join(host.home, "hermes-calls.log"), FAKE_HERMES_MODE: "",
  });
  const hermes = JSON.parse(fs.readFileSync(state, "utf8"))[name];
  assert.ok(hermes, "the Hermes config step must publish the documented service");
  // Stand in for the two expansions Hermes performs; this test does not start Hermes.
  const templates = new Map([["${AIFY_AGENT_ID}", AGENT], ["${workspaceFolder}", process.cwd()]]);
  assert.deepEqual(Object.values(hermes.headers).filter((value) => value.startsWith("${")).sort(), [...templates.keys()].sort());
  const expanded = Object.fromEntries(Object.entries(hermes.headers).map(([key, value]) => [key, templates.get(value) ?? value]));
  return [claude, { ...hermes, headers: expanded }];
}

function rpc(url, headers, method, params, id = 1) {
  return fetch(url, { method: "POST", redirect: "error", headers: { ...headers,
    "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id ?? undefined, method, params }) });
}

async function result(entry, method, params) {
  const response = await rpc(entry.url, entry.headers, method, params);
  assert.equal(response.status, 200, `${method}: ${response.ok ? "unexpected status" : await response.text()}`);
  const reply = await response.json();
  assert.equal(reply.id, 1);
  return reply.result;
}

test("the service guide registers an HTTP-only tool and both session configurations reach it", async (t) => {
  const example = exampleFromGuide();
  const { name, wire, flag, keyFile } = example;
  const endpoint = await serveExample(t, example);
  const host = makeHost();
  const file = path.resolve(host.home, keyFile);
  assert.equal(path.dirname(file), host.home, "the guide's example key file must stay in the fixture home");
  fs.writeFileSync(file, `${KEY}\n`, { mode: 0o600, flag: "wx" });
  const connected = await runConnect(host, [name, endpoint, flag, file]);
  assert.equal(connected.status, 0, connected.stderr);
  const registry = JSON.parse(host.registryBytes());
  assert.deepEqual(Object.keys(registry.services), [name]);
  assert.deepEqual(registry.services[name].mcp ?? [], [], "the service must contribute no local command");
  assert.deepEqual(host.npmCalls(), [], "the service must install no bridge");

  for (const entry of installedEntries(host, name)) {
    assert.equal(entry.url, `${endpoint}${wire.path}`);
    assert.equal(entry.command, undefined);
    const noKey = await rpc(entry.url, {}, "tools/list");
    assert.equal(noKey.status, 401, "control: the tools are not open without the configured key");
    await noKey.text();
    const initialized = await result(entry, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-client", version: "1" } });
    assert.equal(initialized.serverInfo.name, name);
    assert.equal((await rpc(entry.url, entry.headers, "notifications/initialized", {}, null)).status, 202);
    assert.deepEqual((await result(entry, "tools/list")).tools.map((tool) => tool.name), ["echo"]);
    const echo = await result(entry, "tools/call", { name: "echo", arguments: { text: "guide smoke test" } });
    assert.deepEqual(echo.content, [{ type: "text", text: "guide smoke test" }]);
    assert.equal(echo.structuredContent.caller, AGENT);
    assert.match(echo.structuredContent.machine, /:example-host$/);
    assert.equal(path.resolve(echo.structuredContent.folder), process.cwd());
  }
});
