#!/usr/bin/env node
// This launch's per-session MCP servers as one `--mcp-config` document, written to the launch's owner-only session
// folder (lib/session-folder.mjs: ~/.aify/sessions/<agent id>/mcp.json), with the file's path on stdout; nothing at
// all when it has none. claude-aify runs it once per launch, in the folder Claude starts in. The document can hold
// keys, which is why it is never written to the session's temp: a killed launcher leaves its file behind.
//
//   - the stdio servers services opted into every session with (registry.mjs sessionMcpConfig), default mode only;
//   - the services reached over HTTP (lib/session-http.mjs): the launcher's own in every mode, the others in the
//     default mode only, because strict mode carries only its own service.
//
// Everything comes from the launcher: AIFY_SESSION_STDIO_B64 and AIFY_SESSION_HTTP_B64 as rendered,
// AIFY_SESSION_STRICT ("1" in strict mode), AIFY_SESSION_ENDPOINT (the endpoint this launch resolved for its own
// service), AIFY_SESSION_LAUNCHER_PID (the launcher's own pid, which names an unnamed launch's folder; this process's
// parent is a subshell under Git Bash) and AIFY_AGENT_ID. The machine is aify-env's machineIdFor; the folder is this
// process's cwd, the cwd a local MCP process would have reported.
//
// A service with no key gets its entry without X-API-Key and is named on stderr: the service decides. Exit 78 only
// when the document cannot be written at all: rendered input this cannot read, two servers under one name (Claude
// merges servers by name and which one wins is not documented), or a session folder that is not its owner's alone.

import os from "node:os";
import path from "node:path";

import { credentialRead } from "../lib/credential-file.mjs";
import { hostIsWsl, machineIdFor } from "../lib/machine-id.mjs";
import { recordLauncher, sessionFolder, sweepEndedLaunches, writeSessionFile } from "../lib/session-folder.mjs";
import { claudeHttpServers, sessionEndpoint, sessionHttpFromBase64, sessionKey } from "../lib/session-http.mjs";

const EXIT_CONFIG = 78;
const env = process.env;
const strict = env.AIFY_SESSION_STRICT === "1";

function refuse(message) {
  process.stderr.write(`[aify-session-mcp] ${message}\n`);
  process.exit(EXIT_CONFIG);
}

let stdio = {};
let services = [];
try {
  if (!strict && env.AIFY_SESSION_STDIO_B64) stdio = JSON.parse(Buffer.from(env.AIFY_SESSION_STDIO_B64, "base64").toString("utf8")).mcpServers;
  services = sessionHttpFromBase64(env.AIFY_SESSION_HTTP_B64 || "").filter((service) => !strict || service.own);
} catch (error) {
  refuse(`the rendered session entries cannot be read (${error.message}); re-run the installer`);
}

const ownEndpoint = env.AIFY_SESSION_ENDPOINT || "";
const keys = {};
for (const service of services) {
  const { key, refused } = await sessionKey(service, { url: sessionEndpoint(service, ownEndpoint), env, read: credentialRead });
  if (key) keys[service.name] = key;
  else process.stderr.write(`[aify-session-mcp] ${service.name}: no key found (${refused}); the service decides\n`);
}
const http = claudeHttpServers(services, {
  agentId: String(env.AIFY_AGENT_ID || "").trim(),
  machineId: machineIdFor({ platform: process.platform, hostname: os.hostname(), env, isWsl: hostIsWsl() }),
  folder: process.cwd(),
  keys,
  ownEndpoint,
});

const clash = Object.keys(http).filter((name) => Object.hasOwn(stdio ?? {}, name));
if (clash.length) refuse(`${clash.join(", ")}: both a stdio and an http server under one name`);
const mcpServers = { ...stdio, ...http };
if (!Object.keys(mcpServers).length) process.exit(0);

const agentId = String(env.AIFY_AGENT_ID || "").trim();
const launcherPid = Number(env.AIFY_SESSION_LAUNCHER_PID);
const folder = await sessionFolder({ agentId, launcherPid });
if (!folder.ok) refuse(`${folder.problem}; this session's MCP entries are not written there`);
if (!agentId) {
  await recordLauncher(folder.dir, launcherPid);
  for (const name of await sweepEndedLaunches({ keep: path.basename(folder.dir) })) process.stderr.write(`[aify-session-mcp] removed ${name}: its launch has ended\n`);
}
process.stdout.write(await writeSessionFile(folder.dir, "mcp.json", `${JSON.stringify({ mcpServers }, null, 2)}\n`));
