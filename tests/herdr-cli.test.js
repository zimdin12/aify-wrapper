#!/usr/bin/env node
// Talking to Herdr, and the two ways that conversation lies.
//
// FIRST LIE: A ZERO EXIT IS NOT A SUCCESS. Herdr reports its own refusals in the JSON body with exit
// status 0 -- `{"error":{"code":"server_not_running",...}}` is what a stopped server really returned
// in the measured run. A caller that keyed on the exit status alone would read "no server is running"
// as a successful empty answer, and the restore pass would then prune every record on the host.
//
// SECOND LIE: AN UNREADABLE LISTING LOOKS LIKE AN EMPTY ONE. `listPanes` therefore returns its
// failure rather than an empty array, because the one caller that matters has to tell "Herdr says
// there are no panes" from "I could not ask Herdr".
//
// NOTHING HERE STARTS A HERDR. The child process is injected, so these tests judge the parsing and
// the verdicts -- which is where the failures above live -- and never depend on a server existing.

import assert from "node:assert/strict";
import { test } from "node:test";

import { herdr, listPanes } from "../lib/herdr-cli.mjs";

/** A stand-in for spawnSync that returns whatever the test wants, and records how it was called. */
function runner(result) {
  const calls = [];
  const run = (exe, argv, options) => {
    calls.push({ exe, argv, options });
    return typeof result === "function" ? result(exe, argv) : result;
  };
  return { run, calls };
}

const ok = body => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });

test("a successful call returns the parsed body", () => {
  const { run } = runner(ok({ id: "cli:pane:list", result: { panes: [] } }));
  const result = herdr(["pane", "list"], { run, bin: "herdr" });
  assert.equal(result.ok, true);
  assert.equal(result.json.id, "cli:pane:list");
});

test("the binary Herdr itself named is the one used", () => {
  // Using a different `herdr` on PATH would mean talking to a different server than the pane's.
  const { run, calls } = runner(ok({ result: {} }));
  herdr(["pane", "list"], { run, env: { HERDR_BIN_PATH: "C:\\herdr\\herdr.exe" } });
  assert.equal(calls[0].exe, "C:\\herdr\\herdr.exe");
  // With nothing naming a binary, the resolver decides -- and on a host where Herdr is installed
  // that is a real path, not the bare name. The bare name is only what is left when nothing is
  // found on disk, which is what made the operator's first run die with a spawn ENOENT.
  const plain = runner(ok({ result: {} }));
  herdr(["pane", "list"], { run: plain.run, env: {} });
  assert.ok(plain.calls[0].exe.length > 0);
  assert.ok(plain.calls[0].exe === "herdr" || plain.calls[0].exe.includes("herdr"));
});

test("an error in the body is a failure even though the process exited 0", () => {
  // The real shape, from a stopped server in the measured run.
  const body = { id: "cli:pane:list", error: { code: "server_not_running", message: "no herdr server is running" } };
  const { run } = runner(ok(body));
  const result = herdr(["pane", "list"], { run });
  assert.equal(result.ok, false, "a body-level error was read as success");
  assert.match(result.error, /no herdr server/);
});

test("a non-zero exit is a failure and carries what was printed", () => {
  const { run } = runner({ status: 2, stdout: "", stderr: "unknown subcommand" });
  const result = herdr(["pane", "nope"], { run });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /unknown subcommand/);
});

test("a spawn that could not happen at all is a failure, not a crash", () => {
  // A wrapper launch must survive node being unable to start the binary.
  const thrown = herdr(["pane", "list"], {
    run: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /ENOENT/);
  const reported = herdr(["pane", "list"], { run: () => ({ error: new Error("spawn timed out") }) });
  assert.equal(reported.ok, false);
  assert.match(reported.error, /timed out/);
});

test("output that is not JSON is still a success, because some verbs print nothing", () => {
  // `pane report-agent` printed an empty body in the measured run and had done the work.
  const { run } = runner({ status: 0, stdout: "", stderr: "" });
  const result = herdr(["pane", "report-agent"], { run });
  assert.equal(result.ok, true);
  assert.equal(result.json, null);
});

test("listPanes returns the panes Herdr listed", () => {
  const panes = [{ pane_id: "w1:p1" }, { pane_id: "w1:p2", label: "aify:claude-aify:rec1" }];
  const { run } = runner(ok({ result: { panes } }));
  const result = listPanes({ run });
  assert.equal(result.ok, true);
  assert.equal(result.panes.length, 2);
  assert.equal(result.error, null);
});

test("listPanes distinguishes an empty fleet from an unanswerable question", () => {
  // THE DISTINCTION THE PRUNE DEPENDS ON. Both of these produce zero panes; only one of them means
  // there are no panes, and acting on the other would delete every record on the host.
  const empty = listPanes({ run: () => ok({ result: { panes: [] } }) });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.panes, []);

  const down = listPanes({ run: () => ok({ error: { code: "server_not_running", message: "down" } }) });
  assert.equal(down.ok, false, "a stopped server was reported as a successful empty listing");
  assert.deepEqual(down.panes, []);

  // A body with no panes array at all is also not an answer.
  const malformed = listPanes({ run: () => ok({ result: {} }) });
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /no panes array/);
});
