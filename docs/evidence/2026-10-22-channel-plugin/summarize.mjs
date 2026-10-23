// One case of run-3.sh, read back as its named observables: node summarize.mjs <out dir> <case> <message id>.
import fs from "node:fs";
import path from "node:path";

const [out, name, message] = process.argv.slice(2);
const read = (suffix) => { try { return fs.readFileSync(path.join(out, `${name}.${suffix}`), "utf8"); } catch { return ""; } };
const lines = (suffix) => read(suffix).split("\n").filter(Boolean);
const requests = lines("service.jsonl").map((l) => JSON.parse(l));
const who = { 9001: "user-scope", 9002: "plugin" };
const report = [`== ${name}`];
const processes = lines("processes.txt");
report.push(`started: user-scope ${processes.filter((p) => /claude-channel\.js/.test(p)).length}, plugin ${processes.filter((p) => /claude-channel-plugin\.mjs/.test(p)).length}`);
for (const port of [9001, 9002]) {
  const mine = requests.filter((r) => r.port === port);
  const accepted = mine.find((r) => r.event === "claim-accepted");
  report.push(`${who[port]}: requests ${mine.filter((r) => !r.event).length}, claims ${mine.filter((r) => r.url === "/api/v1/dispatch/claim").length}, `
    + `liveness beats ${mine.filter((r) => r.liveness).length}, delivered receipts ${mine.filter((r) => r.method === "PATCH" && /dispatch\/runs/.test(r.url)).length}, `
    + `accepted claim ${accepted ? accepted.messageId : "none"}`);
}
const markers = lines("markers.txt");
report.push(`markers: ${markers.length} (${markers.map((m) => (/claude-channel-plugin/.test(m) ? "plugin" : /claude-channel\.js/.test(m) ? "user-scope" : "?")).join(", ") || "none"})`);
const envelopes = lines("envelopes.txt").filter((l) => l.includes(`message_id="${message}"`));
report.push(`envelopes carrying ${message}: ${envelopes.length ? envelopes.map((l) => /source="([^"]*)"/.exec(l)?.[1]).join(", ") : "none"}`);
report.push(`left after exit: ${read("after-exit.txt").trim() || "(nothing)"}`);
process.stdout.write(`${report.join("\n")}\n\n`);
