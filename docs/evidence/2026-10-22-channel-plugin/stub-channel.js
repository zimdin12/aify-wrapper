// Stands in for aify-comms' claude-channel.js, so the witness runs without the service. It logs who started it (its
// parent's command line), which configuration it came from, and the launcher's variables it inherited. It declares the
// channel capability under a serverInfo name that is neither the plugin's name nor its server key, so the envelope
// shows which name Claude uses, and pushes one event naming its own configuration.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const from = process.env.AIFY_CHANNEL_SOURCE || "user-scope";
// The producer gate the plan proposes for claude-channel.js, emulated: a server pushes only on its own route, the plugin's
// server only when the launcher said plugin, the user-scope server never then. Off unless WITNESS_GATE=1.
const gated = process.env.WITNESS_GATE === "1"
  && ((from === "plugin") !== (process.env.AIFY_CHANNEL_ROUTE === "plugin"));
const log = (line) => appendFileSync("/tmp/aify-channel.log", `${new Date().toISOString()} [${from}] ${line}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let parent = "?";
try { parent = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").join(" ").trim(); } catch { /* not Linux */ }
log(`started pid=${process.pid} ppid=${process.ppid} parent="${parent}" AIFY_CHANNEL_ROUTE=${process.env.AIFY_CHANNEL_ROUTE ?? "(unset)"} AIFY_SERVER_URL=${process.env.AIFY_SERVER_URL ?? "(unset)"}`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log(`in ${message.method ?? "response"}`);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { experimental: { "claude/channel": {} } },
      serverInfo: { name: "serverinfo-name", version: "0.0.1" },
    } });
  } else if (message.method === "notifications/initialized" && gated) {
    log("inert: not this route's producer");
  } else if (message.method === "notifications/initialized") {
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/claude/channel",
        params: { content: `witness event from the ${from} configuration`, meta: { kind: "witness" } } });
      log("pushed the witness event");
    }, 5000);
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}).on("close", () => { log("stdin closed"); process.exit(0); });
