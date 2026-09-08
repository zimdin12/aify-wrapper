// Two launcher defects found on a live host on 2026-09-08, both in hermes-aify.sh.in.
//
// 1. kill_prior killed BY PORT: `lsof -ti tcp:$port | xargs kill` ends every process holding a
//    socket on the agent's gateway port -- clients included -- and the gateway range 8642–9641
//    contains the aify-comms service port (8800), the dashboard (8801) and aify-env (8802).
//    "general-helper-gpt" hashes to 8800; spawning it SIGTERMed aify-env (which long-polls 8800)
//    and every bridge on the machine. The kill must be scoped to hermes gateway processes.
// 2. A dashboard Reset sets AIFY_HERMES_FRESH_CONTEXT=1, which this launcher never read, so a
//    Reset resumed the old (often dead) session. The launcher must mint an id hermes has never seen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "wrappers", "hermes-aify.sh.in"), "utf8");
const portKillLine = () => TEMPLATE.split("\n").find((l) => l.includes('lsof -ti tcp:"$host_port"'));

test("the port-kill line filters the port's holders down to hermes gateway processes", () => {
  const line = portKillLine();
  assert.ok(line, "the port-kill line is still present");
  assert.match(line, /ps -o pid=,args=/, "pids are resolved to their command lines first");
  assert.match(line, /hermes dashboard --port/, "only a hermes gateway's command line is killed");
  assert.doesNotMatch(line, /lsof -ti tcp:"\$host_port" 2>\/dev\/null \| xargs kill/, "the unfiltered kill is gone");
});

test("the delivery-loop kill is anchored to the whole agent id", () => {
  assert.match(TEMPLATE, /pkill -f "hermes-managed-host\.js run \$agent_id\$"/, "`run lc-coder` must not match `run lc-coder-2`");
});

test("a fresh-context launch mints a new session id before the handle is exported, and drops the marker", () => {
  const block = TEMPLATE.indexOf('if [ "${AIFY_HERMES_FRESH_CONTEXT:-}" = "1" ]');
  const firstExport = TEMPLATE.indexOf('if [ "$HERMES_EXPLICIT_SESSION_HANDLE" = "true" ] && [ -n "$HERMES_SESSION_HANDLE" ]');
  assert.ok(block > 0, "the fresh-context block exists");
  assert.ok(block < firstExport, "it runs before the explicit-handle export");
  assert.match(TEMPLATE, /HERMES_EXPLICIT_SESSION_HANDLE="true"/);
  assert.match(TEMPLATE, /rm -f "\$\{TEMP:-\$\{TMP:-\/tmp\}\}\/aify-hermes-session-\$\{HERMES_AIFY_AGENT_ID:-\}"/);
});

test("the port-kill pipeline spares a plain client and kills a gateway holding the same port", async (t) => {
  if (process.platform === "win32" || spawnSync("sh", ["-c", "command -v lsof >/dev/null"]).status !== 0) {
    t.skip("needs lsof on a POSIX host");
    return;
  }
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const hold = (argv0) => spawn("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}; ${argv0 ? `exec -a "${argv0}" sleep 20` : "sleep 20"}`], { stdio: "ignore" });
  const client = hold("");
  const gateway = hold(`hermes dashboard --port ${port} --host 127.0.0.1`);
  const alive = (child) => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  try {
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(alive(client) && alive(gateway), true, "both holders are up before the kill");
    spawnSync("bash", ["-c", `host_port=${port}; ${portKillLine().trim()}`]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(alive(client), true, "a plain client on the port survives");
    assert.equal(alive(gateway), false, "a hermes gateway on the port is killed");
  } finally {
    try { client.kill("SIGKILL"); } catch { /* gone */ }
    try { gateway.kill("SIGKILL"); } catch { /* gone */ }
    server.close();
  }
});
