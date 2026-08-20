#!/usr/bin/env node
// Is an installed launcher still built from the registry this host has?
//
// THIS EXISTS BECAUSE THE FINGERPRINT HAD NO READER. It was baked into every launcher and printed by
// `--check`, and the phase gate claimed a stale launcher "reports itself stale" — but nothing anywhere
// compared it to anything. A value written and displayed is not a check; it is a value. Severity comes
// from the consumer, and until this module there was no consumer.
//
// EVERYTHING HERE READS. A launcher is judged by its text, never by running it. Asking a pre-contract
// wrapper about itself by executing it is how a four-second probe once superseded a live environment
// bridge and reaped a managed fleet — the same rule that makes the allowlist read a marker instead of
// running the file.

import assert from "node:assert/strict";
import { test } from "node:test";

import { stalenessOf, launcherFingerprint } from "../lib/staleness.mjs";

const launcher = (fingerprint) => [
  "#!/bin/bash",
  'HARNESS_WRAPPER_VERSION="0.6.0"',
  `HARNESS_REGISTRY_FINGERPRINT="${fingerprint}"`,
  'exec claude "$@"',
].join("\n");

test("a launcher built from the CURRENT registry is current", () => {
  const result = stalenessOf({
    launchers: [{ name: "claude-aify", text: launcher("abc123") }],
    registryFingerprint: "abc123",
  });
  assert.deepEqual(result.current.map((l) => l.name), ["claude-aify"]);
  assert.deepEqual(result.stale, []);
});

test("a launcher built from a DIFFERENT registry is stale, and says both fingerprints", () => {
  // The whole point. A reader has to be able to see that they differ, not just be told they do.
  const result = stalenessOf({
    launchers: [{ name: "claude-aify", text: launcher("old999") }],
    registryFingerprint: "new111",
  });
  assert.deepEqual(result.stale.map((l) => l.name), ["claude-aify"]);
  assert.equal(result.stale[0].installed, "old999");
  assert.equal(result.stale[0].expected, "new111");
});

test("a launcher with NO fingerprint line is UNKNOWN, not current", () => {
  // A pre-contract wrapper, installed before this existed. Reading its absence as "matches" would make
  // every launcher that predates the feature report as fine, which is the population most likely stale.
  const result = stalenessOf({
    launchers: [{ name: "old-aify", text: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.5.7"\n' }],
    registryFingerprint: "new111",
  });
  assert.deepEqual(result.unknown.map((l) => l.name), ["old-aify"]);
  assert.deepEqual(result.current, []);
  assert.deepEqual(result.stale, []);
});

test("an EMPTY fingerprint is unknown, not a match against an empty registry", () => {
  // Blank means nobody looked. Empty-registry has a real digest of its own, and conflating them would
  // report an unbuilt launcher as agreeing with a host that has no services.
  const result = stalenessOf({
    launchers: [{ name: "a", text: launcher("") }],
    registryFingerprint: "",
  });
  assert.deepEqual(result.unknown.map((l) => l.name), ["a"]);
});

test("a mixed set is split three ways in one pass", () => {
  const result = stalenessOf({
    launchers: [
      { name: "claude-aify", text: launcher("same") },
      { name: "codex-aify", text: launcher("different") },
      { name: "pi-aify", text: "#!/bin/bash\n" },
    ],
    registryFingerprint: "same",
  });
  assert.deepEqual(result.current.map((l) => l.name), ["claude-aify"]);
  assert.deepEqual(result.stale.map((l) => l.name), ["codex-aify"]);
  assert.deepEqual(result.unknown.map((l) => l.name), ["pi-aify"]);
});

test("NO launchers at all is unknown, never 'all current'", () => {
  // A host with nothing installed has nothing verified. Reporting it as current is the false green this
  // whole family of checks exists to prevent.
  const result = stalenessOf({ launchers: [], registryFingerprint: "abc" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /no launchers/i);
});

test("the verdict names the remedy, and it is REINSTALL rather than restart", () => {
  // A launcher is exec'd and gone by the time anything is running, so relaunching an agent changes
  // nothing about it. Getting this backwards sends somebody restarting a fleet for no effect.
  const result = stalenessOf({
    launchers: [{ name: "claude-aify", text: launcher("old") }],
    registryFingerprint: "new",
  });
  assert.match(result.summary, /reinstall/i);
  // Not merely "the word relaunch is absent" -- the summary DOES mention relaunching, to say it will
  // not help. What must be absent is an INSTRUCTION to restart, because a launcher has exec'd and gone
  // by the time anything is running.
  assert.doesNotMatch(result.summary, /restart/i, "the remedy told somebody to restart");
  assert.match(result.summary, /relaunching an agent will not/i, "it should say why restarting is futile");
});

test("everything current with at least one launcher is ok", () => {
  const result = stalenessOf({
    launchers: [{ name: "a", text: launcher("x") }, { name: "b", text: launcher("x") }],
    registryFingerprint: "x",
  });
  assert.equal(result.ok, true);
});

test("anything unknown is NOT ok, even with nothing stale", () => {
  // Unanswered is not a pass. A launcher we cannot judge has not been judged.
  const result = stalenessOf({
    launchers: [{ name: "a", text: launcher("x") }, { name: "b", text: "#!/bin/bash\n" }],
    registryFingerprint: "x",
  });
  assert.equal(result.ok, false);
});

test("launcherFingerprint READS and cannot be tricked by a mention", () => {
  // Same anchored-assignment rule as the allowlist marker: a file that merely talks about the variable
  // has not declared one, and a substring check is what anyone writes first.
  assert.equal(launcherFingerprint(launcher("abc")), "abc");
  assert.equal(launcherFingerprint('# HARNESS_REGISTRY_FINGERPRINT="abc"\n'), null);
  assert.equal(launcherFingerprint('echo "set HARNESS_REGISTRY_FINGERPRINT=abc"\n'), null);
  assert.equal(launcherFingerprint(""), null);
  assert.equal(launcherFingerprint(null), null);
});
