// Fail-closed: each mutant puts back one defect -- the 0.8.6 behaviour's predecessor, or a hole the review of 0.8.6
// found -- and the test NAMED for it must go red. Survivors, or a tree that does not restore byte-identical, exit 1.
//   node docs/evidence/2026-10-05-env-detach/detach-mutants.mjs <aify-wrapper checkout>
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.argv[2];
const TESTS = [
  "tests/herdr-aify-env-joins-and-stops-by-name.test.js",
  "tests/herdr-aify-attaches-a-tui.test.js",
  "tests/herdr-supervisor.test.js",
  "tests/the-gateway-token-is-never-printed.test.js",
];
const BIN = "bin/herdr-aify.mjs";
const STOP = "lib/herdr-stop.mjs";
const SUP = "lib/herdr-supervisor.mjs";
const OWNER = "lib/herdr-owner.mjs";
const HERMES = "wrappers/hermes-aify.sh.in";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const once = (from, to) => (s) => {
  if (s.split(from).length !== 2) throw new Error(`site not unique: ${from.slice(0, 60)}`);
  return s.replace(from, to);
};
const MUTANTS = [
  [STOP, "a bare stop ends a recorded env instance first (the incident)",
    once('  if (target === "resident") {', '  if (target === "resident" && !state?.invocation) {'),
    "A BARE --stop ADDRESSES ONLY THE RESIDENT'S SOCKET"],
  [STOP, "every stop is the env's", once('return argv.includes("env") ? "env" : "resident";', 'return "env";'),
    "A BARE --stop IS THE RESIDENT'S"],
  [BIN, "only a live launcher counts as running (the old refusal)",
    once('  if (answer === "serving") return "join";', '  if (answer === "serving" && alreadyRunning(state)) return "join";'),
    "A SECOND LAUNCH JOINS"],
  [BIN, "leaving the session ends the instance", once('    if (ended === "left") return await detach(0);\n', ""),
    "leaving the session DETACHES"],
  [BIN, "a headless start is ended at once", once(
    '  process.stderr.write("herdr-aify: no terminal to attach to; `herdr-aify env` in a terminal attaches to it\\n");\n  return await detach(0);',
    '  process.stderr.write("herdr-aify: no terminal to attach to; `herdr-aify env` in a terminal attaches to it\\n");\n  return await shutdown(0);'),
    "leaves the instance running"],
  // The review of 0.8.6: mutants the first suite let through, and the defects it found.
  [SUP, "M1 the env server is a plain child of the launcher", once("{ env: serverEnv, independent: true }", "{ env: serverEnv }"),
    "THE SERVER IS SPAWNED INDEPENDENT"],
  [BIN, "M2 a second launch asks the operator's own herdr, not the recorded instance",
    once("env: herdrServerEnv(env, recorded) }));", "env }));"), "A SECOND LAUNCH JOINS"],
  [BIN, "M3 a signal always detaches, even mid-start", once("(up ? detach(0) : shutdown(0))", "detach(0)"),
    "A SIGNAL BEFORE THE INSTANCE IS UP"],
  [BIN, "M4 a signal always tears down (the old behaviour)", once("(up ? detach(0) : shutdown(0))", "shutdown(0)"),
    "A SIGNAL ONCE IT IS UP DETACHES"],
  [BIN, "M5 detaching forgets the instance", once(
    "      await owner.close();\n    } catch {\n      // Nothing to release",
    "      await owner.close();\n      clearProfileOwner(profileRoot, invocation);\n    } catch {\n      // Nothing to release"),
    "CONTROL: a recorded instance herdr says is gone"],
  [STOP, "M6 the stop asks once, straight after",
    once('while (answer !== "not-running" && deadline - now() > everyMs) {', "while (false) {"), "A SERVER THAT TAKES A MOMENT TO EXIT"],
  [STOP, "D1 a failed env --stop clears the pointer",
    once('  if (after === "not-running") clearProfileOwner(profileRoot, state.invocation);', "  clearProfileOwner(profileRoot, state.invocation);"),
    "A FAILED `env --stop`"],
  [BIN, "D2 no start lock", once("  const claim = claimStart(profileRoot);", "  const claim = { ok: true, release() {} };"),
    "TWO LAUNCHES AT ONCE"],
  [SUP, "D3 a stop in the spawn window stops nothing",
    once("    if (!this.#stopped && !this.#serving && this.#server && (await this.#settled(this.#server)).ok) this.#serving = true;\n", ""),
    "A SIGNAL BETWEEN THE SPAWN"],
  [OWNER, "D2b a live holder's lock is taken over", once("holder <= 0 || alive(holder)) return", "holder <= 0) return"),
    "the start lock"],
  // The verification round on 388cd55.
  [BIN, "D4 a pointer that cannot be written keeps the lock", once("    await owner.close().catch(() => {});\n    claim.release();\n    throw err;", "    throw err;"),
    "A POINTER THAT CANNOT BE WRITTEN"],
  [BIN, "D5 a start that throws skips the teardown",
    once('  }).catch(err => ({ ok: false, phase: "start", error: err?.message || String(err) }));', "  });"),
    "A START THAT THROWS"],
  // comms-senior-dev's review of e51b83e.
  [OWNER, "R1 a reclaim acts on its cached verdict", once('    if (now !== deadClaim) return "changed";\n', ""),
    "TWO LAUNCHES RECLAIMING ONE DEAD LOCK"],
  [OWNER, "R1-ABA a reclaim matches the claim by its pid alone",
    once('    if (now !== deadClaim) return "changed";',
      '    if (Number(now.trim().split(" ")[0]) !== Number(deadClaim.trim().split(" ")[0])) return "changed";'),
    "A REUSED PID"],
  [OWNER, "R1b a reclaim in progress is ignored", once('    if (err?.code === "EEXIST") return "busy";', '    if (err?.code === "EEXIST") return "removed";'),
    "a reclaim already in progress refuses"],
  [BIN, "R2 the teardown forgets an instance it could not confirm gone",
    once("      if (gone) clearProfileOwner(profileRoot, invocation);", "      clearProfileOwner(profileRoot, invocation);"),
    "A TEARDOWN THAT CANNOT CONFIRM THE SERVER GONE"],
  [BIN, "R2b the teardown never forgets", once("    const gone = result?.confirmedGone === true;", "    const gone = false;"),
    "CONTROL: a teardown that confirms the server gone forgets it"],
  [STOP, "R3 each question may take the CLI's full timeout", once("    answer = ask(left);", "    answer = ask(15000);"),
    "THE STOP'S WAIT IS FIVE SECONDS OF WALL TIME"],
  // The gateway token in a managed hermes console (graph-tech-lead's spawn test, 2026-10-05).
  [HERMES, "T1 the success line prints the host's whole answer",
    once('  echo "[hermes-aify] managed gateway host ready on port ${_hermes_host_port:-unknown}" >&2',
      '  echo "[hermes-aify] managed gateway host ready on port ${_hermes_host_port:-unknown}: $HERMES_HOST_JSON" >&2'),
    "THE SUCCESS LINE names the gateway without its token"],
  [HERMES, "T2 the parse-failure line prints the host's whole answer",
    once("(${#HERMES_HOST_JSON} bytes; not shown, it carries the gateway token)", "(${#HERMES_HOST_JSON} bytes): $HERMES_HOST_JSON"),
    "THE PARSE-FAILURE LINE names what came back without its token"],
  [HERMES, "T4 the failure line redacts by the token's closing quote (8668655)",
    once("(${#HERMES_HOST_JSON} bytes; not shown, it carries the gateway token)",
      "$(printf '%s' \"$HERMES_HOST_JSON\" | sed -E 's/(\"token\"[[:space:]]*:[[:space:]]*\")[^\"]*\"/\\1<redacted>\"/g')"),
    "A TRUNCATED ANSWER prints no token either"],
  [STOP, "R3-LATE the time left is checked only before the sleep",
    once("    if (left <= 0) break;\n    answer = ask(left);", "    answer = ask(Math.max(1, left));"),
    "A SLEEP THAT WAKES LATE"],
];
// --test-force-exit: a mutant that leaks a handle must still REPORT its named failure; without it the file hangs to
// the timeout and node prints nothing for it.
const run = () => spawnSync(process.execPath, ["--test", "--test-force-exit", ...TESTS], {
  cwd: ROOT, encoding: "utf8", timeout: 300_000,
  env: { ...process.env, AIFY_AGENT_ID: "", AIFY_AGENT_LEASE: "" },
});
const files = [...new Set(MUTANTS.map(([file]) => file))];
const good = new Map(files.map((file) => [file, fs.readFileSync(path.join(ROOT, file))]));
const restore = () => { for (const [file, bytes] of good) fs.writeFileSync(path.join(ROOT, file), bytes); };
const survivors = [];
try {
  for (const [file, label, mutate, expected] of MUTANTS) {
    fs.writeFileSync(path.join(ROOT, file), mutate(good.get(file).toString("utf8")));
    const r = run();
    const failed = (r.stdout || "").split("\n").filter((l) => l.startsWith("not ok"));
    const killed = r.status !== 0 && failed.some((l) => l.includes(expected));
    if (!killed) survivors.push(label);
    console.log(`${killed ? "KILLED  " : "SURVIVED"} ${label}: exit=${r.status}; ${failed.map((l) => l.slice(0, 100)).join(" | ") || "nothing failed"}`);
    restore();
  }
} finally {
  restore();
}
for (const [file, bytes] of good) if (sha(fs.readFileSync(path.join(ROOT, file))) !== sha(bytes)) throw new Error(`${file} not restored`);
const restored = run();
console.log(`restored: exit=${restored.status} ${(restored.stdout || "").split("\n").filter((l) => /^# (pass|fail)/.test(l)).join(" ")}`);
if (survivors.length || restored.status !== 0) { console.log(`FAILED: ${survivors.join(", ")}`); process.exit(1); }
console.log(`all ${MUTANTS.length} mutants killed at their named test`);
