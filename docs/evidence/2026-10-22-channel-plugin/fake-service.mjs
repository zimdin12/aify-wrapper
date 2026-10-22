// A stand-in for the aify-comms service, for the real-bridge witness (run-3.sh). It listens on two ports so each
// configured channel server can be told apart by where it calls: the user-scope server's own env names :9001, the
// plugin's server inherits :9002 from the launcher's environment. Every request is logged with its port. One channel
// run is handed to the first claim that asks for it; its message id is what the envelope must carry.
import { appendFileSync } from "node:fs";
import http from "node:http";

const MESSAGE = process.argv[2] || "witness-msg-1";
let pending = { id: "witness-run-1", messageId: MESSAGE, executionMode: "channel", from: "witness-sender", subject: "witness",
  body: "the witness message", priority: "normal" };
const log = (entry) => appendFileSync("/tmp/fake-service.jsonl", `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
for (const port of [9001, 9002]) {
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* logged raw */ }
      let answer = {};
      if (req.url === "/api/v1/dispatch/claim" && pending) {
        answer = { run: pending };
        log({ port, event: "claim-accepted", runId: pending.id, messageId: pending.messageId });
        pending = null;
      }
      if (req.url === "/api/v1/dispatch/controls/claim") answer = { controls: [] };
      log({ port, method: req.method, url: req.url, liveness: parsed.liveness === true, status: parsed.status });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  }).listen(port, "127.0.0.1");
}
