// A stand-in for the Anthropic API inside the throwaway container, so the fake key meets no real service. It logs every
// request, and for a messages call the <channel ...> envelopes in its body: that is the text the model is given, so it
// is where the channel's source label is read. Remote managed settings answer 404 (no organization policy). Everything
// else answers 401.
import { appendFileSync } from "node:fs";
import http from "node:http";

const log = (line) => appendFileSync("/tmp/fake-api.log", `${new Date().toISOString()} ${line}\n`);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    log(`${req.method} ${req.url}`);
    for (const envelope of new Set(body.match(/<channel[^>]*>/g) ?? [])) log(`  envelope ${envelope.replace(/\\"/g, "\"")}`);
    if (req.url.startsWith("/api/claude_code/settings")) {
      res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"type":"error","error":{"type":"authentication_error","message":"fake"}}');
  });
}).listen(9999, "127.0.0.1");
