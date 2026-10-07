// Shell supplies its own native PID, exact $0, and EPOCHREALTIME, never Node's parent or a rounded clock.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [root, agentId, instance, harness, pidText, launcher, clock, herdrPane] = process.argv.slice(2);
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
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, `${agentId}.${lifetime}.json`), JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(lifetime + "\n");
