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
import os from "node:os";
import { pathToFileURL } from "node:url";
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
  // Actual deletion and preservation are exercised below against the real marker writers.
});

for (const [fresh, failure] of [[true, ""], [false, ""], [true, "import"], [true, "rm"]]) {
  test(failure ? `a ${failure} cleanup failure warns but the fresh launch continues` :
    `the launcher's reset block ${fresh ? "clears" : "preserves"} the lifetime markers only`, async (t) => {
    const stdio = path.join(process.env.AIFY_COMMS_REPO || path.resolve(ROOT, "../aify-comms"), "mcp/stdio");
    if (!fs.existsSync(path.join(stdio, "hermes-endpoint.js"))) {
      t.skip("needs the aify-comms marker writers; set AIFY_COMMS_REPO");
      return;
    }
    const endpoint = await import(pathToFileURL(path.join(stdio, "hermes-endpoint.js")));
    const ready = await import(pathToFileURL(path.join(stdio, "hermes-loop-ready.js")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-markers-"));
    const target = "fixture.target";
    const sibling = "fixture.target-sibling";
    const old = "fixture_old_session";
    const start = TEMPLATE.indexOf('if [ "${AIFY_HERMES_FRESH_CONTEXT:-}" = "1" ]');
    const block = TEMPLATE.slice(start, TEMPLATE.indexOf("\nfi", start) + 3).replaceAll("@@HERMES_STDIO_DIR@@",
      failure === "import" ? path.join(dir, "missing-stdio") : stdio);
    assert.ok(start < TEMPLATE.indexOf('aify_hermes_kill_prior "$HERMES_AIFY_AGENT_ID"'));
    try {
      for (const id of [target, sibling]) {
        endpoint.writeSessionIdMarker(id, old, { tempDir: dir });
        endpoint.writeGatewayUrlMarker(id, "ws://127.0.0.1:19001/api/ws", { tempDir: dir });
        ready.writeLoopReady(id, dir);
        fs.writeFileSync(path.join(dir, `aify-hermes-port-${endpoint.sanitizeAgentId(id)}`), "19001");
      }
      const before = Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
      assert.equal(Object.keys(before).length, 8);
      const safe = endpoint.sanitizeAgentId(target);
      const session = `aify-hermes-session-${safe}`;
      if (failure === "rm") {
        fs.unlinkSync(path.join(dir, session));
        fs.mkdirSync(path.join(dir, session));
        fs.writeFileSync(path.join(dir, session, "retained"), before[session]);
      }
      // Execute only the real reset conditional. Never run the launcher's reap or triad branches.
      const result = spawnSync("bash", ["-c", `${block}\nprintf '%s' "$HERMES_SESSION_HANDLE"`], {
        encoding: "utf8", env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir,
          AIFY_HERMES_FRESH_CONTEXT: fresh ? "1" : "",
          HERMES_AIFY_AGENT_ID: target, HERMES_SESSION_HANDLE: old },
      });
      assert.equal(result.status, 0, result.stderr);
      const warnings = result.stderr.split("\n").filter(line => line.startsWith("[hermes-aify] WARN:"));
      assert.equal(warnings.length, failure ? 1 : 0, result.stderr);
      if (failure) {
        assert.ok(warnings[0].startsWith(`[hermes-aify] WARN: could not clear ${target}'s markers: `));
        assert.match(warnings[0], failure === "import" ? /Cannot find module/ : /directory|EISDIR/);
      }
      for (const [name, bytes] of Object.entries(before)) {
        if (failure === "rm" && name === session) {
          assert.equal(fs.readFileSync(path.join(dir, session, "retained"), "utf8"), bytes);
          continue;
        }
        const cleared = fresh && !failure && ["session", "gateway", "loop-ready"].some(kind => name === `aify-hermes-${kind}-${safe}`);
        if (cleared) assert.equal(fs.existsSync(path.join(dir, name)), false, name);
        else assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), bytes, name);
      }
      if (fresh) assert.notEqual(result.stdout, old);
      else assert.equal(result.stdout, old);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

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
