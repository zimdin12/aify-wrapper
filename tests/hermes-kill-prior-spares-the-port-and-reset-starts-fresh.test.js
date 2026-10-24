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

test("the delivery-loop kill goes through the node reap, whose id match is whole (tests/hermes-prior-runs.test.js)", () => {
  assert.match(TEMPLATE, /aify-hermes-reap-prior\.mjs" --agent "\$agent_id"/, "`run lc-coder` must not match `run lc-coder-2`");
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
      assert.ok(!process.env.AIFY_COMMS_REPO, "explicit AIFY_COMMS_REPO must contain the marker writers");
      t.skip("needs the aify-comms marker writers; set AIFY_COMMS_REPO");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-markers-"));
    const temp = path.join(dir, "temp");
    const home = path.join(dir, "home");
    const bundle = path.join(dir, "installed-wrapper");
    const savedEnv = { ...process.env };
    const target = "fixture.target";
    const sibling = "fixture.target-sibling";
    const old = "fixture_old_session";
    try {
      for (const root of [temp, home, bundle]) fs.mkdirSync(root);
      // Seal before importing the real owners, including os.homedir() on Windows.
      Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home,
        USERPROFILE: home, HERMES_HOME: path.join(home, ".hermes") });
      const endpoint = await import(pathToFileURL(path.join(stdio, "hermes-endpoint.js")));
      const ready = await import(pathToFileURL(path.join(stdio, "hermes-loop-ready.js")));
      const { defaultGatewayMarkerDir } = await import(pathToFileURL(path.join(stdio, "hermes-gateway-marker.mjs")));
      const gateways = defaultGatewayMarkerDir();
      assert.equal(gateways, path.join(home, ".aify", "hermes", "gateways"));
      assert.notEqual(gateways, temp);

      // Mirror the packaged helper directories, never a live bridge's node_modules.
      const packaged = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).files;
      for (const name of ["bin/", "lib/", "wrappers/", "render.sh"]) {
        assert.ok(packaged.includes(name), `${name} must ship in the package`);
        fs.cpSync(path.join(ROOT, name), path.join(bundle, name), { recursive: true });
      }
      const values = Object.fromEntries([...TEMPLATE.matchAll(/@@([A-Z0-9_]+)@@/g)].map((m) => [m[1], ""]));
      Object.assign(values, { WRAPPER_DIR: bundle.replaceAll("\\", "/"),
        HERMES_STDIO_DIR: (failure === "import" ? path.join(dir, "missing-stdio") : stdio).replaceAll("\\", "/") });
      const launcher = path.join(dir, "hermes-aify");
      const render = spawnSync("bash", [path.join(bundle, "render.sh").replaceAll("\\", "/"),
        "hermes-aify.sh.in", launcher.replaceAll("\\", "/"),
        ...Object.entries(values).map(([key, value]) => `${key}=${value}`)], { encoding: "utf8" });
      assert.equal(render.status, 0, render.stderr);
      const emitted = fs.readFileSync(launcher, "utf8");
      const start = emitted.indexOf('if [ "${AIFY_HERMES_FRESH_CONTEXT:-}" = "1" ]');
      assert.ok(start > 0 && start < emitted.indexOf('aify_hermes_kill_prior "$HERMES_AIFY_AGENT_ID"'));
      const block = emitted.slice(start, emitted.indexOf("\nfi", start) + 3);
      const wrapperRoot = emitted.split("\n").find(line => line.startsWith('AIFY_WRAPPER_DIR_FWD='));
      assert.ok(wrapperRoot);

      for (const id of [target, sibling]) {
        assert.equal(endpoint.writeSessionIdMarker(id, old, { tempDir: temp }), true);
        assert.equal(endpoint.writeGatewayUrlMarker(id, "ws://127.0.0.1:19001/api/ws", { tempDir: temp }), true);
        assert.equal(endpoint.writeGatewayUrlMarker(id, "ws://127.0.0.1:19002/api/ws", { gatewayTokenEnv: "FIXTURE_TOKEN" }), true);
        ready.writeLoopReady(id, temp);
        endpoint.agentEndpoint(id, { tempDir: temp }); // The real key writer, without any port probe.
        await endpoint.resolveGatewayPort(id, { tempDir: temp, portFree: async () => true });
      }
      const before = [temp, gateways].flatMap(root => fs.readdirSync(root).map(name =>
        [path.join(root, name), fs.readFileSync(path.join(root, name), "utf8")]));
      assert.equal(before.length, 12);
      const safe = endpoint.sanitizeAgentId(target);
      const session = path.join(temp, `aify-hermes-session-${safe}`);
      if (failure === "rm") {
        fs.unlinkSync(session);
        fs.mkdirSync(session);
        fs.writeFileSync(path.join(session, "retained"), old);
      }
      // Execute the emitted Reset caller only, before reap, host or triad can run.
      const preload = pathToFileURL(path.join(ROOT, "tests/test-data/fresh-markers-sealed.mjs")).href;
      const result = spawnSync("bash", ["-c", `${wrapperRoot}\n${block}\nprintf '%s' "$HERMES_SESSION_HANDLE"`], {
        encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${preload}`,
          AIFY_HERMES_FRESH_CONTEXT: fresh ? "1" : "",
          HERMES_AIFY_AGENT_ID: target, HERMES_SESSION_HANDLE: old },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /FORBIDDEN/, "cleanup must not spawn or use the network");
      const warnings = result.stderr.split("\n").filter(line => line.startsWith("[hermes-aify] WARN:"));
      assert.equal(warnings.length, failure ? 1 : 0, result.stderr);
      if (failure) {
        assert.ok(warnings[0].startsWith(`[hermes-aify] WARN: could not clear ${target}'s markers: `));
        assert.match(warnings[0], failure === "import" ? /Cannot find module/ : /directory|EISDIR/);
      }
      for (const [file, bytes] of before) {
        if (failure === "rm" && file === session) {
          assert.equal(fs.readFileSync(path.join(session, "retained"), "utf8"), bytes);
          continue;
        }
        const cleared = fresh && !failure && ["session", "gateway", "loop-ready"].some(kind => path.basename(file) === `aify-hermes-${kind}-${safe}`);
        if (cleared) assert.equal(fs.existsSync(file), false, `Reset must clear ${file}`);
        else assert.equal(fs.readFileSync(file, "utf8"), bytes, file);
      }
      if (fresh) assert.notEqual(result.stdout, old);
      else assert.equal(result.stdout, old);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
