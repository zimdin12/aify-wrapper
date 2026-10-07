import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "8ecc46f8-9e99-4703-9df9-e34cc50faaba";
const OWN = "179d14a8-51ac-45c9-8221-dc977a6f8102";
const keys = ["AIFY_LIFETIME", "AIFY_ENV_INSTANCE", "AIFY_ENV_URL"];
const inherited = { AIFY_AGENT_ID: "host-worker", AIFY_SESSION_MODE: "managed",
  AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_LIFETIME: HOST,
  AIFY_ENV_INSTANCE: "test-host", AIFY_ENV_URL: "http://127.0.0.1:1" };
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const shellPath = (value) => process.platform === "win32"
  ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;
function privateEnv(home) {
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    TMPDIR: home, TEMP: home, TMP: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
}
function bash() {
  // Resolve on demand inside a test, without an import-time shell probe.
  const name = process.platform === "win32" ? "bash.exe" : "bash";
  const executable = (process.env.PATH ?? "").split(path.delimiter)
    .map((directory) => path.join(directory, name)).find((file) => fs.existsSync(file));
  assert.ok(executable, "Bash unavailable on PATH");
  return executable;
}
function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  // Reap only this test-owned Bash tree, including its immediate fake jobs.
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"],
    { stdio: "ignore", timeout: 1000, killSignal: "SIGKILL" });
  child.kill("SIGKILL");
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
}
// One real Bash coordinator per client or guard batch joins parallel subshell rows running production slices/helpers and fake runtimes with env/rm utilities and a Bash-function writer; no installer, rendered/full launcher, or real agent runtime.
// Bounds fixture scheduling and process startup, not product latency.
const FAKE_BATCH_FIXTURE_BUDGET_MS = 20_000;
function batchRun(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    const timer = setTimeout(() => {
      stop(child);
      reject(new Error(`fake Bash batch exceeded ${FAKE_BATCH_FIXTURE_BUDGET_MS / 1000}-second fixture execution budget: ${stderr}`));
    }, FAKE_BATCH_FIXTURE_BUDGET_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stderr }); });
  });
}
function writer(args, uuid = OWN, collision = false) {
  let source = read("bin/aify-resident-record.mjs");
  for (const line of ['import fs from "node:fs";', 'import path from "node:path";', 'import { randomUUID } from "node:crypto";']) {
    assert.equal(source.split(line).length, 2, `writer import boundary: ${line}`);
    source = source.replace(line, "");
  }
  assert.doesNotMatch(source, /^import /m, "unexpected writer import");
  const result = { mkdir: [], writes: [], uuids: 0, stdout: "", exit: 0 }, stop = {};
  try {
    new vm.Script(source).runInNewContext({ path, randomUUID: () => { result.uuids++; return uuid; },
      fs: { mkdirSync: (...args) => result.mkdir.push(args), writeFileSync: (...args) => {
        result.writes.push(args);
        if (collision && args[2].flag === "wx") throw Object.assign(new Error("collision"), { code: "EEXIST" });
      } }, console: { error() {} },
      process: { argv: ["node", "writer", ...args], ppid: 99999, env: { AIFY_LIFETIME: HOST },
        stdout: { write: (text) => { result.stdout += text; } }, exit: (code) => { result.exit = code; throw stop; } }
    }, { timeout: 100 });
  } catch (error) { if (error !== stop) result.error = error; }
  return result;
}
function assertRecord(args, uuid = OWN) {
  const result = writer(args, uuid);
  assert.equal(result.exit, 0); assert.equal(result.error, undefined);
  assert.equal(result.uuids, 1); assert.equal(result.stdout, `${uuid}\n`);
  assert.deepEqual(result.mkdir.map(([dir, options]) => [dir, { ...options }]), [[args[0], { recursive: true }]]);
  assert.equal(result.writes.length, 1);
  const [file, bytes, options] = result.writes[0];
  assert.equal(file, path.join(args[0], `${args[1]}.${uuid}.json`));
  assert.deepEqual({ ...options }, { flag: "wx", mode: 0o600 });
  assert.ok(bytes.endsWith("\n"));
  assert.deepEqual(JSON.parse(bytes), { agentId: args[1], lifetime: uuid, instance: args[2], harness: args[3],
    pid: Number(args[4]), launcher: args[5], writtenAtUs: Number(args[6]), ...(args[7] ? { herdrPane: args[7] } : {}) });
}

test("the real record writer binds identity, exclusive ownership, PID, clock and optional pane", () => {
  const args = ["residents", "new-resident", "test-host", "claude", "43210", "/c/exact/launcher", "1780000000123456", "w1:p3"];
  for (const harness of ["claude", "codex", "hermes"]) {
    args[3] = harness; assertRecord(args); assertRecord([...args.slice(0, 7), ""]);
  }
  for (const [index, invalid] of [[4, "0"], [4, "1.5"], [6, "1780000000123"], [6, "not-a-clock"]]) {
    const input = [...args]; input[index] = invalid;
    const result = writer(input);
    assert.equal(result.exit, 78); assert.equal(result.uuids, 0); assert.deepEqual(result.writes, []);
  }
  const collision = writer(args, OWN, true);
  assert.equal(collision.error?.code, "EEXIST"); assert.equal(collision.stdout, "");
});

// Keep closed source regions in their original order, including enclosing guards.
// Boundaries are not the lifetime/export/release statements subject to deletion.
function wrapper(client, bridge) {
  const source = read(`wrappers/${client}-aify.sh.in`), ranges = [];
  function region(start, end) {
    const a = source.indexOf(start), b = end === null ? source.length : source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `${client} region boundary ${start}`);
    assert.equal(source.indexOf(start, a + start.length), -1, `ambiguous region ${start}`);
    ranges.push([a + (start.startsWith("fi\n") ? 3 : 0), b]);
  }
  region('AIFY_BRIDGE_DIR_FWD="@@BRIDGE_DIR@@"', "# ── Herdr:");
  region('HARNESS_IDENTITY="', 'HARNESS_CWD="');
  if (client === "claude") {
    region('CLAUDE_RESUME_ID="${CLAUDE_SESSION_ID:-}"', "# Role, model and effort for the id known now");
    region('export AIFY_RUNTIME="claude-code"', "# Expose the aify service URL");
  } else if (client === "codex") {
    region("CODEX_ARGS=()", 'if [ "${AIFY_MANAGED_VIA_WRAPPER:-}" = "1" ]; then');
    region('if [ -n "$CODEX_AIFY_AGENT_ID" ]; then\n', "# Expose the aify service URL");
  } else {
    region('HERMES_AIFY_AGENT_ID="$HARNESS_IDENTITY"', "# Role, model and effort for the id known now");
    region('\nif [ -n "$HERMES_AIFY_AGENT_ID" ]; then\n', "# LOCAL PATCH (temporary, until upstream)");
  }
  region("AIFY_SESSION_MODE_INFERRED=0", client === "claude" ? "# claude-aify ALWAYS" : client === "codex"
    ? "# Fresh codex-aify launch" : "# Load aify-comms' durable Hermes runtime shim");
  if (client === "claude") {
    region("AIFY_RUNTIME_RUNNING=0\n_aify_runtime_exited()", "# The lease is claimed by the run");
    region('if [ "$CLAUDE_AIFY_SHARED" = true ]; then', null);
  } else if (client === "codex") {
    region('fi\n\nif [ "$CODEX_AIFY_SHARED" != true ]; then\n', 'if ! wait_for_port "$PORT"; then');
    region('\nrun_codex_foreground --remote', null);
  } else {
    region('if [ -n "$HERMES_AIFY_AGENT_ID" ] &&', "  # Per-agent TUI active-session file:");
    region("  AIFY_RUNTIME_RUNNING=0\n  _aify_hermes_on_exit()", "  # NOTE (2026-06-02 hotfix/restore-hermes-tui)");
    region('  echo "[hermes-aify] no stored session', "# RESIDENT agent-id launch:");
    region("# Plain sessions and subcommands", null);
  }
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i - 1][1] <= ranges[i][0], `${client} source order`);
  return ranges.map(([a, b]) => source.slice(a, b)).join("\n").replaceAll("@@BRIDGE_DIR@@", bridge);
}
const probes = `
cygpath() { printf '%s' "$2"; }
# Codex's resident row uses the direct spawn; its managed rows use setsid.
command() {
  if [ "\${1:-}" = -v ] && [ "\${2:-}" = setsid ] && [ "\${PROBE##*/}" = resident ]; then return 1; fi
  builtin command "$@"
}
snapshot() {
  env -0 > "$PROBE/$1.env"
  printf '%s\\n' "$1" >> "$PROBE/events"
  local file
  for file in "$HOME/.aify/residents/"*.json; do
    [ -f "$file" ] || continue
    printf '%s\\0' "\${file##*/}" >> "$PROBE/$1.records"
  done
}
node() {
  case "$1" in */aify-resident-record.mjs) ;; *) echo 'unexpected node call' >&2; return 99;; esac
  printf '%s\\0' "$@" >> "$PROBE/writer.args"
  printf 'fixture-owned\\n' > "$HOME/.aify/residents/$3.${OWN}.json"
  printf 'sibling bytes\\n' > "$HOME/.aify/residents/$3.${HOST}.json"
  printf '%s\\n' '${OWN}'
}
sh() {
  case "$1" in */aify-runtime-exited.sh) snapshot report;; *) echo 'unexpected sh call' >&2; return 99;; esac
}
claude() { snapshot runtime; return 7; }
codex() {
  case " $* " in *' app-server '*) snapshot app; return 0;; esac
  wait "$APP_SERVER_PID"
  snapshot runtime
  return 7
}
setsid() { "$@"; }
hermes() { snapshot runtime; return 7; }
aify_hermes_kill_prior() { :; }
aify_hermes_exec_plain_or_tui() { hermes; }
kill() { return 1; }
rm() { case " $* " in *residents*) command rm "$@";; esac; }
CLAUDE_MCP_FLAGS=(); CLAUDE_PERMISSION_FLAGS=()
CODEX_PERMISSION_FLAGS=(); CODEX_HERDR_HOOKS=(); CODEX_APP_SERVER_CONFIG=()
HERMES_PERMISSION_FLAGS=(); HERMES_LOOP_PID=999999
APP_SERVER_URL=unused; LOG_FILE="$PROBE/app.log"
AIFY_MCP_CONFIG="$PROBE/mcp"; AIFY_HOOK_SETTINGS="$PROBE/hooks"
unset EPOCHREALTIME
EPOCHREALTIME=1780000000.123456
`;
function fixture(home) {
  const bridge = path.join(home, "bridge"), bin = path.join(bridge, "node_modules/aify-wrapper/bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["aify-lease.sh", "aify-lifetime.sh", "aify-inherited-session.sh", "aify-resident-record.mjs"])
    fs.copyFileSync(path.join(root, "bin", name), path.join(bin, name));
  return { bridge: bridge.replaceAll("\\", "/"), bin };
}
const nul = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\0").filter(Boolean) : [];
function environment(file) {
  assert.ok(fs.existsSync(file), `missing child environment ${file}`);
  return Object.fromEntries(nul(file).map((entry) => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
}
function checkRow(home, row, client, expected, agent, minted) {
  const probe = path.join(home, row), runtime = environment(path.join(probe, "runtime.env"));
  assert.equal(fs.readFileSync(path.join(probe, "status"), "utf8").trim(), "7", "runtime exit");
  assert.equal(fs.readFileSync(path.join(probe, "events"), "utf8").split("\n").filter((event) => event === "runtime").length, 1, "runtime reach");
  assert.equal(runtime.AIFY_AGENT_ID, agent || undefined, `${client}/${row} runtime identity`);
  const events = fs.readFileSync(path.join(probe, "events"), "utf8").trim().split("\n");
  assert.deepEqual(events, [...(client === "codex" ? ["app"] : []), "runtime", ...(client !== "hermes" || agent ? ["report"] : [])], "natural runtime/report order and exactly once");
  for (const key of keys) assert.equal(runtime[key], expected[key], `${client}/${row} runtime ${key}`);
  if (client === "codex") {
    const app = environment(path.join(probe, "app.env"));
    for (const key of keys) assert.equal(app[key], expected[key], `${row} before app-server spawn ${key}`);
  }
  const args = nul(path.join(probe, "writer.args")), residents = path.join(probe, ".aify/residents");
  if (minted) {
    assert.equal(args.length, 9, "one writer invocation");
    assert.equal(args[2], agent); assert.equal(args[3], "test-host"); assert.equal(args[4], client);
    assert.equal(args[5], "43210", "native PID collaborator");
    assert.equal(args[6], `/fake/${client}-aify`, "literal launcher");
    assert.equal(args[7], "1780000000123456", "shell epoch microseconds"); assert.equal(args[8], "w1:p3");
    assert.equal(fs.readFileSync(path.join(probe, "pid.input"), "utf8"), fs.readFileSync(path.join(probe, "shell.pid"), "utf8"), "PID lookup receives shell $$");
    assertRecord(args.slice(1), runtime.AIFY_LIFETIME);
    const names = [`${agent}.${OWN}.json`, `${agent}.${HOST}.json`].sort();
    assert.deepEqual(nul(path.join(probe, "runtime.records")).sort(), names);
    assert.deepEqual(nul(path.join(probe, "report.records")).sort(), names, "report precedes release");
    assert.equal(environment(path.join(probe, "report.env")).AIFY_LIFETIME, OWN);
    assert.deepEqual(fs.readdirSync(residents), [`${agent}.${HOST}.json`], "only owned lifetime removed");
    assert.equal(fs.readFileSync(path.join(residents, `${agent}.${HOST}.json`), "utf8"), "sibling bytes\n");
  } else {
    assert.deepEqual(args, [], "no writer request"); assert.deepEqual(nul(path.join(probe, "runtime.records")), []);
    assert.deepEqual(fs.existsSync(residents) ? fs.readdirSync(residents) : [], []);
  }
}
for (const client of ["claude", "codex", "hermes"]) {
  test(`${client}: real parsing, lifetime callers and natural teardown preserve all four ownership rows`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lifetime-fake-"));
    try {
      const { bridge, bin } = fixture(home);
      // Fake lease effects and PID lookup, never lifetime decisions or teardown triggers.
      fs.appendFileSync(path.join(bin, "aify-lease.sh"), `\naify_lease_claim() { :; }\naify_lease_attach() { :; }\naify_lease_release() { :; }\naify_lease_pid() { printf '%s' "$1" > "$PROBE/pid.input"; printf 43210; }\n`);
      const rows = [
        ["resident", ["--aify-agent", "new-resident", "--resident"], inherited, { AIFY_LIFETIME: OWN, AIFY_ENV_INSTANCE: "test-host" }, "new-resident", true],
        ["matched", ["--aify-agent", "host-worker", "--managed"], inherited, inherited, "host-worker", false],
        ["mismatched", ["--aify-agent", "different-worker", "--managed"], inherited, {}, "different-worker", false],
        ["anonymous", ["--resident"], Object.fromEntries(keys.map((key) => [key, inherited[key]])), {}, "", false],
      ];
      const sliced = wrapper(client, bridge);
      fs.writeFileSync(path.join(home, "slice.sh"), sliced);
      fs.writeFileSync(path.join(home, "probes.sh"), probes);
      let batch = "set -u\njobs=()\n";
      for (const [row, args, env] of rows) {
        const probe = path.join(home, row); fs.mkdirSync(path.join(probe, ".aify/residents"), { recursive: true });
        batch += `(\n(\nset -e\nexport HOME=${quote(shellPath(probe))} PROBE=${quote(shellPath(probe))} AIFY_HERDR_PANE_ID=w1:p3\n`;
        batch += Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join("");
        batch += `printf '%s' "$$" > "$PROBE/shell.pid"\nset -- ${args.map(quote).join(" ")}\n. ${quote(shellPath(path.join(home, "probes.sh")))}\n. ${quote(shellPath(path.join(home, "slice.sh")))}\n)\nstatus=$?\nprintf '%s' "$status" > ${quote(shellPath(path.join(probe, "status")))}\n) &\njobs+=("$!")\n`;
      }
      batch += 'for job in "${jobs[@]}"; do wait "$job" || exit $?; done\n';
      const result = await batchRun(bash(), ["--noprofile", "--norc", "-c", batch, `/fake/${client}-aify`], privateEnv(home));
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
      for (const [row, , , expected, agent, minted] of rows) checkRow(home, row, client, expected, agent, minted);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test("shared adoption guards distinguish resident, empty identity and each missing carrier", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lifetime-guards-"));
  try {
    const { bridge, bin } = fixture(home);
    fs.appendFileSync(path.join(bin, "aify-lease.sh"), '\naify_lease_pid() { printf 43210; }\n');
    const rows = [["resident-same", "host-worker", "resident", inherited, { AIFY_LIFETIME: OWN, AIFY_ENV_INSTANCE: "test-host" }],
      ["empty", "", "managed", { ...inherited, AIFY_AGENT_ID: "" }, {}],
      ...keys.map((key) => [`missing-${key}`, "host-worker", "managed", Object.fromEntries(Object.entries(inherited).filter(([name]) => name !== key)), {}])];
    fs.writeFileSync(path.join(home, "probes.sh"), probes);
    let batch = "set -eu\njobs=()\n";
    for (const [row, agent, mode, env] of rows) {
      const probe = path.join(home, row); fs.mkdirSync(path.join(probe, ".aify/residents"), { recursive: true });
      batch += `(\nexport HOME=${quote(shellPath(probe))} PROBE=${quote(shellPath(probe))}\n`;
      batch += Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join("");
      batch += `. ${quote(shellPath(path.join(home, "probes.sh")))}\n. ${quote(`${bridge}/node_modules/aify-wrapper/bin/aify-lease.sh`)}\naify_lifetime_start ${quote(bridge)} ${quote(agent)} claude ${quote(mode)}\nsnapshot runtime\n) &\njobs+=("$!")\n`;
    }
    batch += 'for job in "${jobs[@]}"; do wait "$job" || exit $?; done\n';
    const result = await batchRun(bash(), ["--noprofile", "--norc", "-c", batch, "/fake/claude-aify"], privateEnv(home));
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    for (const [row, , , , expected] of rows) {
      const env = environment(path.join(home, row, "runtime.env"));
      for (const key of keys) assert.equal(env[key], expected[key], `${row} ${key}`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("native: shared lifetime boundary preserves literal $0 and the waiting shell PID", { timeout: 10_000 }, async () => {
  const deadline = Date.now() + 8500, home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-lifetime-native-"));
  try {
    const executable = bash(), { bridge } = fixture(home);
    const spellings = process.platform === "win32" ? ["/c/aify-test/claude-aify", "C:/aify-test/claude-aify"] : ["/owned/claude-aify"];
    for (const launcher of spellings) {
      const before = Date.now() * 1000;
      const script = `set -euo pipefail; unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL
. "$1/node_modules/aify-wrapper/bin/aify-lease.sh"
aify_lifetime_start "$1" spelling-proof claude resident
if [ -r /proc/$$/winpid ]; then IFS= read -r native_pid < /proc/$$/winpid; else native_pid=$$; fi
printf '%s %s\\n' "$native_pid" "$AIFY_LIFETIME"
IFS= read -r release
`;
      const child = spawn(executable, ["--noprofile", "--norc", "-c", script, launcher, bridge],
        { env: { ...privateEnv(home), AIFY_LIFETIME: HOST, AIFY_ENV_INSTANCE: "test-host", AIFY_HERDR_PANE_ID: "w1:p3" } });
      let stderr = "", stdout = "";
      child.stderr.on("data", (bytes) => { stderr += bytes; }); child.stdout.on("data", (bytes) => { stdout += bytes; });
      const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); });
      const timer = setTimeout(() => stop(child), Math.max(1, deadline - Date.now()));
      try {
        await new Promise((resolve, reject) => {
          child.stdout.on("data", () => { if (stdout.includes("\n")) resolve(); });
          closed.then(() => { if (!stdout.includes("\n")) reject(new Error(`native boundary ended before wait: ${stderr}`)); }, reject);
        });
        const [pid, lifetime] = stdout.trim().split(" "), dir = path.join(home, ".aify/residents"), name = `spelling-proof.${lifetime}.json`;
        assert.deepEqual(fs.readdirSync(dir), [name]);
        const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        assert.equal(record.launcher, launcher, "native argument conversion must not rewrite $0");
        assert.equal(record.pid, Number(pid), "independently read waiting-shell native PID");
        assert.match(lifetime, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.notEqual(lifetime, HOST);
        assert.deepEqual(record, { agentId: "spelling-proof", lifetime, instance: "test-host", harness: "claude",
          pid: Number(pid), launcher, writtenAtUs: record.writtenAtUs, herdrPane: "w1:p3" });
        assert.ok(Number.isSafeInteger(record.writtenAtUs) && record.writtenAtUs >= before && record.writtenAtUs <= Date.now() * 1000 + 1000, "real epoch microseconds");
        child.stdin.end("release\n"); assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
        fs.unlinkSync(path.join(dir, name));
      } finally { clearTimeout(timer); if (child.exitCode === null) { stop(child); await closed; } }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
