#!/usr/bin/env node
// The two Herdr commands' own logic, which `every-export-is-tested.test.js` does not reach.
//
// WHY THIS FILE EXISTS. That gate walks `lib/` only, so anything exported from `bin/` is ungoverned
// by it — and both of these carry real decisions: how a wrapper's own argv is separated from this
// tool's flags, and how a spent invocation is told from a fresh one. Neither would fail loudly if it
// broke. The first would record a mangled command that only misfires after a reboot; the second
// would report a used invocation as reusable, which is the guarantee the operator asked for by name.
//
// IMPORTING A BIN MUST BE INERT, and these imports are the proof: both files guard their entry point
// on being the program, so importing them here starts no Herdr, no daemon and no agent.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { installPlugin, parseArgs } from "../bin/aify-herdr-pane.mjs";
import { defaultProfileRoot, invocationStatus, invocationsOnDisk } from "../lib/herdr-records.mjs";

test("the wrapper's own argv is taken verbatim from after the separator", () => {
  // It is replayed by a restore, so anything this parser 'understood' would be a way for the replayed
  // command to differ from the one the operator typed.
  const parsed = parseArgs(["claim", "--wrapper", "claude-aify", "--", "claude-aify", "--resume", "--wrapper", "x"]);
  assert.equal(parsed.command, "claim");
  assert.equal(parsed.wrapper, "claude-aify");
  // The second `--wrapper` belongs to the wrapper's command and must NOT be read as ours.
  assert.deepEqual(parsed.argv, ["claude-aify", "--resume", "--wrapper", "x"]);
});

test("commands with no argv and no flags parse to nothing rather than to guesses", () => {
  assert.deepEqual(parseArgs(["restore"]), { command: "restore", wrapper: null, argv: [] });
  assert.deepEqual(parseArgs([]), { command: null, wrapper: null, argv: [] });
  assert.deepEqual(parseArgs(["claim", "--wrapper"]), { command: "claim", wrapper: null, argv: [] });
});

test("an empty wrapper command is not mistaken for an absent separator", () => {
  // `-- ` with nothing after it means "no argv", and claim refuses to record an empty one.
  assert.deepEqual(parseArgs(["claim", "--wrapper", "x", "--"]).argv, []);
});

test("a spent invocation is reported as spent, which is what makes resurrection impossible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-status-"));
  const invocations = path.join(root, "invocations");
  const fresh = path.join(invocations, "11111111-1111-4111-8111-111111111111");
  const spent = path.join(invocations, "22222222-2222-4222-8222-222222222222");
  fs.mkdirSync(fresh, { recursive: true });
  fs.mkdirSync(spent, { recursive: true });
  fs.writeFileSync(path.join(fresh, "instance.json"), "{}");
  // The daemon publishes these at readiness; their existence is exactly how it detects a reused one.
  fs.writeFileSync(path.join(spent, "instance.json"), "{}");
  fs.writeFileSync(path.join(spent, "ready.json"), "{}");

  const rows = invocationsOnDisk({ profileRoot: root });
  const byId = Object.fromEntries(rows.map(row => [row.invocation, row]));
  assert.equal(rows.length, 2);
  assert.equal(byId["11111111-1111-4111-8111-111111111111"].spent, false);
  assert.equal(byId["22222222-2222-4222-8222-222222222222"].spent, true);
  assert.deepEqual(byId["22222222-2222-4222-8222-222222222222"].used, ["ready.json"]);
});

test("a host that has never run the command reports nothing rather than failing", () => {
  assert.deepEqual(invocationsOnDisk({ profileRoot: path.join(os.tmpdir(), "aify-herdr-never-run-here") }), []);
});

/** A profile holding two spent invocations, and the socket answer `--status` will be given for the current one. */
async function statusWith(current, result) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-herdr-current-"));
  const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
  for (const id of ids) {
    fs.mkdirSync(path.join(root, "invocations", id), { recursive: true });
    fs.writeFileSync(path.join(root, "invocations", id, "ready.json"), "{}");
  }
  const asked = [];
  const rows = await invocationStatus({
    profileRoot: root, env: { HERDR_BIN_PATH: "herdr-this-test-never-runs" },
    owner: async () => (current ? { owned: false, reason: "stale-pointer", invocation: ids[current] } : { owned: false, reason: "no-pointer" }),
    cli: (argv, { env }) => (asked.push(env.XDG_CONFIG_HOME), result),
  });
  return { root, ids, asked, byId: Object.fromEntries(rows.map(row => [row.invocation, row])) };
}

test("--status says which invocation is current and asks only its own socket whether it is serving", async () => {
  // THE WORK-PC REHEARSAL (2026-10-28): `spent: true` was read as "finished" on an instance that was running. Spent
  // stays what it is; `current` and `serving` answer the question. The pointer's launcher being gone (detached) is the
  // ordinary case, so it decides nothing here: the socket does.
  for (const [result, serving] of [[{ ok: true }, true], [{ ok: false, code: "server_not_running" }, false], [{ ok: false, error: "timed out" }, "unknown"]]) {
    const { root, ids, asked, byId } = await statusWith(1, result);
    assert.equal(byId[ids[1]].current, true);
    assert.equal(byId[ids[1]].serving, serving, JSON.stringify(result));
    assert.equal(byId[ids[1]].spent, true, "spent is still reported, unchanged");
    assert.equal(byId[ids[0]].current, false);
    assert.equal("serving" in byId[ids[0]], false, "a row nobody asked about claims nothing");
    assert.deepEqual(asked, [path.join(root, "invocations", ids[1], "herdr-config")], "asked another socket, or more than one");
  }
});

test("`herdr-aify --status` and `status` print what invocationStatus says, as JSON", async () => {
  // The command's own wiring: it printed invocationsOnDisk, which has no `current`, for as long as nothing drove it.
  const { main } = await import("../bin/herdr-aify.mjs");
  const rows = [{ invocation: "x", spent: true, current: true, serving: true }];
  for (const argv of [["--status"], ["status"]]) {
    let printed = "";
    const io = { stdout: { write: chunk => (printed += chunk) }, stderr: { write: () => true } };
    assert.equal(await main(argv, { io, status: async () => rows, runner: () => assert.fail("--status started something") }), 0);
    assert.deepEqual(JSON.parse(printed), rows, argv.join(" "));
  }
});

test("--status with no pointer: every row is not current, and no socket is asked", async () => {
  const { ids, asked, byId } = await statusWith(null, { ok: true });
  assert.deepEqual(ids.map(id => byId[id].current), [false, false]);
  assert.deepEqual(asked, []);
});

test("the plugin link points at a directory that really holds the manifest", () => {
  // THE HALF-INSTALLED STATE THIS GUARDS. Without the link nothing restores, and every other part of
  // the feature still looks like it is working: panes get labelled, the ledger fills up, Herdr
  // declines the resume exactly as designed, and no startup hook ever runs. A link pointing at a
  // directory with no manifest in it produces precisely that state, with a success message.
  //
  // No Herdr is contacted: with none running the call fails, and the PATH it resolved is what the
  // assertion is about.
  const result = installPlugin({ env: { HERDR_BIN_PATH: path.join(os.tmpdir(), "no-herdr-here") } });
  assert.ok(fs.existsSync(path.join(result.pluginDir, "herdr-plugin.toml")), `no manifest at ${result.pluginDir}`);
  // The link itself may succeed on a host with Herdr installed -- the resolver finds the real binary
  // even when HERDR_BIN_PATH names nothing. What this pins is the PATH it hands Herdr.
});

test("invocations live under the aify home, not in temp", () => {
  const root = defaultProfileRoot({ home: path.join("C:", "Users", "Someone") });
  assert.ok(root.includes(".aify"));
  assert.ok(root.endsWith("herdr"));
});
