import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ManagedChannelPolicyFile, policyPreparationCommand } from "../lib/channel-posix-policy.mjs";
import { policySources, withOurChannel } from "../lib/channel-policy.mjs";

// Explicit IO boundary unit fixture. Native permissions and the real sudo command are separate Linux proof.
function policyFile({ platform = "linux", uid = 0, existing = null, dropIns = false, race = false,
  loseWrite = false, existingDirectory = false, temporaryCollision = false } = {}) {
  const file = policySources(platform)[0].path;
  const state = { text: existing, calls: [], pending: null, temporary: false, directory: existingDirectory };
  const read = source => source.kind === "dir" ? (dropIns ? { unreadable: true, why: "admin drop-ins present" } : null) : state.text;
  const io = {
    mkdirSync: (...args) => { state.calls.push(["mkdir", ...args]); if (state.directory) throw Object.assign(new Error("exists"), { code: "EEXIST" }); state.directory = true; },
    statSync: () => ({ isDirectory: () => true }),
    chmodSync: (...args) => state.calls.push(["chmod", ...args]),
    openSync: (...args) => { state.calls.push(["open", ...args]); if (temporaryCollision) throw Object.assign(new Error("temporary exists"), { code: "EEXIST" }); state.temporary = true; return 7; },
    writeFileSync: (fd, text) => { state.calls.push(["write", fd]); state.pending = loseWrite ? "{}" : text; },
    fchmodSync: (...args) => state.calls.push(["fchmod", ...args]),
    closeSync: (...args) => state.calls.push(["close", ...args]),
    linkSync: (...args) => {
      state.calls.push(["link", ...args]);
      if (race) state.text = '{"operator":"arrived after the read"}';
      if (state.text !== null) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
      state.text = state.pending;
    },
    // Native copyFileSync's default replacement semantics: the overwrite mutant must be caught, not mocked away.
    copyFileSync: (...args) => {
      state.calls.push(["copy", ...args]);
      if (race) state.text = '{"operator":"arrived after the read"}';
      state.text = state.pending;
    },
    unlinkSync: (...args) => { state.calls.push(["unlink", ...args]); state.temporary = false; },
  };
  return { file, state, policy: new ManagedChannelPolicyFile({ platform, uid, read, io, nonce: () => "unit-only" }) };
}

for (const platform of ["linux", "darwin"]) test(`${platform}: prepare creates only absent policy, rereads it and is idempotent`, () => {
  const m = policyFile({ platform });
  const first = m.policy.prepare({ path: m.file });
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual(JSON.parse(m.state.text), JSON.parse(withOurChannel(null).text));
  assert.equal(m.state.temporary, false);
  assert.equal(m.state.calls.find(call => call[0] === "open")[2], "wx");
  assert.equal(m.state.calls.find(call => call[0] === "fchmod")[2], 0o644);
  assert.equal(m.state.calls.find(call => call[0] === "chmod")[2], 0o755);
  const calls = m.state.calls.length;
  assert.equal(m.policy.prepare({ path: m.file }).ok, true);
  assert.equal(m.state.calls.length, calls, "an admitted existing file was touched on rerun");
});

for (const existing of ["", "  ", "{}", "{", '{"operator":"keep"}', { unreadable: true }]) test(`existing admin input ${JSON.stringify(existing)} is never touched`, () => {
  const m = policyFile({ existing });
  const result = m.policy.prepare({ path: m.file });
  assert.equal(result.ok, false);
  assert.deepEqual(m.state.text, existing, "an existing admin file was overwritten");
  assert.deepEqual(m.state.calls, [], "existing admin input reached filesystem mutation");
});

test("drop-ins and unknown read results fail closed before filesystem mutation", () => {
  const drop = policyFile({ dropIns: true });
  assert.equal(drop.policy.prepare({ path: drop.file }).ok, false);
  assert.deepEqual(drop.state.calls, []);
  const unknown = policyFile();
  unknown.state.text = undefined;
  assert.equal(unknown.policy.prepare({ path: unknown.file }).ok, false);
  assert.deepEqual(unknown.state.calls, []);
});

test("a file arriving after the absence read is not overwritten", () => {
  const m = policyFile({ race: true });
  const result = m.policy.prepare({ path: m.file });
  assert.equal(m.state.text, '{"operator":"arrived after the read"}', "exclusive publication overwrote a raced admin file");
  assert.equal(result.ok, false);
  assert.equal(m.state.temporary, false);
});

test("a successful write without read-back admission is refused", () => {
  const m = policyFile({ loseWrite: true });
  const result = m.policy.prepare({ path: m.file });
  assert.equal(result.ok, false);
  assert.match(result.reason, /read back/);
});

test("existing parent directory permissions are not changed", () => {
  const m = policyFile({ existingDirectory: true });
  assert.equal(m.policy.prepare({ path: m.file }).ok, true);
  assert.equal(m.state.calls.some(call => call[0] === "chmod"), false);
});

test("a preexisting temporary name is not unlinked", () => {
  const m = policyFile({ temporaryCollision: true });
  assert.equal(m.policy.prepare({ path: m.file }).ok, false);
  assert.equal(m.state.calls.some(call => call[0] === "unlink"), false);
});

for (const uid of [1000, null]) test(`prepare refuses non-root or unknown uid ${uid}`, () => {
  const m = policyFile({ uid });
  assert.equal(m.policy.prepare({ path: m.file }).ok, false);
  assert.deepEqual(m.state.calls, []);
});

for (const wrong of [undefined, "managed-settings.json", "/etc/claude-code/managed-settings.json/", "/other.json"]) test(`prepare requires the exact explicit managed path ${wrong}`, () => {
  const m = policyFile();
  assert.equal(m.policy.prepare({ path: wrong }).ok, false);
  assert.deepEqual(m.state.calls, []);
});

test("the printed policy-only command parses as exact shell argv, including apostrophes and spaces", () => {
  const expected = ["/a path/o'neil/node", "/helper's path/channel-install.mjs", "prepare-policy", "--path", "/Library/Application Support/ClaudeCode/managed-settings.json"];
  const command = policyPreparationCommand({ node: expected[0], module: expected[1], file: expected[4] });
  assert.ok(command.startsWith("sudo -- "));
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  // Parse-only sink: do not invoke sudo. The native proof executes the unchanged command with real sudo.
  const emit = "printf '%s\\0' " + command.slice("sudo -- ".length);
  const actual = spawnSync(bash, ["-c", emit], { encoding: "utf8" });
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(actual.stdout.split("\0").slice(0, -1), expected);
  const invalid = spawnSync(bash, ["-n", "-c", "printf 'unterminated"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0, "the shell syntax probe cannot refuse malformed input");
});
