#!/usr/bin/env node
// Plants for lib/hermes-turn-start.py: each replaces one string, runs the Hermes turn-start test file, and restores.
// A row passes when the file goes RED and, for a named test, that test is among the failures; the control must stay
// GREEN. Run in the foreground: it edits the module under the suite.
//   node docs/evidence/2026-10-20-hermes-turn-start/plants.mjs > docs/evidence/2026-10-20-hermes-turn-start/plants.txt

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = path.join(ROOT, "lib", "hermes-turn-start.py");
const TEST = path.join(ROOT, "tests", "a-hermes-turn-carries-what-the-turn-start-services-say.test.js");

const ROWS = [
  { id: "control-comment", from: "# node on PATH, looked up at each turn when unset", to: "# node on PATH, looked up at each turn when unset (planted)", expect: "GREEN" },
  { id: "subagent-asks", from: 'if kwargs.get("platform") == "subagent":', to: 'if kwargs.get("platform") == "never-a-platform":', expect: "A SUBAGENT'S TURN" },
  { id: "folder-ignores-hermes", from: "return str(resolve_agent_cwd())", to: 'return ""', expect: "THE TURN CARRIES" },
  { id: "outside-hermes-invents-a-folder", from: '    except Exception:\n        return ""', to: '    except Exception:\n        return "C:/somewhere-else"', expect: "OUTSIDE HERMES" },
  { id: "session-id-fixed", from: '"session_id": kwargs.get("session_id")', to: '"session_id": "fixed-session"', expect: "THE TURN CARRIES" },
  { id: "output-unparsed", from: 'return {"context": json.loads(printed)["hookSpecificOutput"]["additionalContext"]}', to: 'return {"context": printed}', expect: "THE TURN CARRIES" },
  { id: "no-guard", from: '"timeout": _GUARD_S}', to: '"timeout": None}', expect: "A RUNNER THAT NEVER EXITS" },
  { id: "failure-raises", from: "        return None\n\n\ndef register", to: "        raise\n\n\ndef register", expect: "NO FAILURE REACHES HERMES" },
  { id: "wrong-hook-name", from: 'ctx.register_hook("pre_llm_call", _context)', to: 'ctx.register_hook("pre_llm_cal", _context)', expect: "THE TURN CARRIES" },
];

const original = fs.readFileSync(MODULE, "utf8");
let wrong = 0;
try {
  for (const row of ROWS) {
    const count = original.split(row.from).length - 1;
    if (count !== 1) {
      console.log(`${row.id}: ANCHOR ${count === 0 ? "MISS" : `MATCHES ${count} TIMES`}`);
      wrong += 1;
      continue;
    }
    fs.writeFileSync(MODULE, original.replace(row.from, row.to));
    const run = spawnSync(process.execPath, ["--test", TEST], { encoding: "utf8", timeout: 120_000 });
    fs.writeFileSync(MODULE, original);
    const failed = [...(run.stdout || "").matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
    const green = run.status === 0;
    const verdict = row.expect === "GREEN"
      ? (green ? "GREEN as expected" : `RED, expected GREEN (failed: ${failed.join(" | ")})`)
      : (!green && failed.some((name) => name.startsWith(row.expect)) ? "RED as expected"
        : green ? "STILL GREEN" : `RED elsewhere (failed: ${failed.join(" | ")})`);
    if (!verdict.endsWith("as expected")) wrong += 1;
    console.log(`${row.id}: ${verdict}; exit ${run.status}`);
  }
} finally {
  fs.writeFileSync(MODULE, original);
}
const restored = fs.readFileSync(MODULE, "utf8") === original;
console.log(`${ROWS.length} rows, ${wrong} not as expected; module restored: ${restored}`);
process.exit(wrong === 0 && restored ? 0 : 1);
