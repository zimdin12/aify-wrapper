// Shell supplies its own native PID, exact $0, and EPOCHREALTIME, never Node's parent or a rounded clock.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [root, agentId, instance, harness, pidText, launcher, clock, herdrPane, captureJson] = process.argv.slice(2);
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const pid = Number(pidText), writtenAtUs = Number(clock);
if (!root || !id.test(agentId ?? "") || !id.test(instance ?? "") || !["claude", "codex", "hermes"].includes(harness)
  || !/^[1-9][0-9]*$/.test(pidText ?? "") || !Number.isSafeInteger(pid) || !launcher
  || !/^[0-9]{16}$/.test(clock ?? "") || !Number.isSafeInteger(writtenAtUs) || writtenAtUs < 1e15) {
  console.error("resident lifetime: invalid launcher identity or epoch-microsecond clock");
  process.exit(78);
}
const lifetime = randomUUID();
const record = { agentId, lifetime, instance, harness, pid, launcher, writtenAtUs, ...(herdrPane ? { herdrPane } : {}) };
// Optional startup provenance never invalidates the process record or grants authority by itself.
try {
  const captured = JSON.parse(captureJson);
  if (captured && !Array.isArray(captured) && captured.agentId === agentId && captured.harness === harness
    && instance === "residents" && harness === "claude" && captured.intent === "replace" && captured.producer === "SessionStart"
    && typeof captured.storeId === "string" && captured.storeId.trim()
    && Number.isSafeInteger(captured.incarnation) && captured.incarnation > 0
    && Number.isSafeInteger(captured.revision) && captured.revision > 0
    && Number.isSafeInteger(captured.stopRevision) && captured.stopRevision >= 0
    && typeof captured.stopReceipt === "string" && /^[0-9a-f]{64}$/.test(captured.stopReceipt)) {
    const { intent, producer, storeId, incarnation, revision, stopRevision, stopReceipt } = captured;
    record.operatorStart = { agentId, intent, harness, producer, storeId, incarnation, revision, stopRevision, stopReceipt };
  }
} catch { /* Missing or malformed capture leaves a legacy, non-clearing record. */ }
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, `${agentId}.${lifetime}.json`), JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(lifetime + "\n");
