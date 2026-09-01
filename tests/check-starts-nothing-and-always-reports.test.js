// `--check` answers "is this configured and can it find its runtime" WITHOUT touching anything.
//
// WRAP-M2, external review round 7. `pi-aify` broke both halves of that contract. Its session-state
// probe sits at line 183 of the rendered launcher and its report at 237, so:
//
//   * it made an HTTP request to the service on a command whose whole promise is that it starts and
//     touches nothing, and
//   * on a BRIDGE-OWNED agent it exited 1 from the guard that follows, having printed no report at
//     all -- an operator asking "is this wrapper configured" was told to stop an agent instead.
//
// Nothing compared those two positions, because nothing ran the command against a service that
// answers. The other three launchers are fine by construction: hermes and codex handle `--check`
// inline in the argument loop above every probe, and claude's report sits well before its first
// request. That is a difference no generic scan would call a defect.
//
// WHAT THIS FILE CANNOT PROVE, AND WHY IT DOES NOT PRETEND TO. The obvious test is a local HTTP
// server that records whether it was asked. It was written, and its zero meant nothing: MEASURED on
// this host, a bash spawned from node cannot reach a node HTTP server on 127.0.0.1 at all -- plain
// `curl --max-time 3` to a listening port returns exit 28, timed out, 0 bytes, and the server counts
// no hit. So "the launcher did not call the service" and "nothing here can call anything" produce an
// identical result, and an assertion that cannot distinguish them is worse than none: it reads as
// coverage. A probe that cannot return PRESENT cannot return ABSENT.
//
// So the network claim is dropped and the two halves that ARE observable here are pinned: the
// launcher exits 0 and prints its report under `--check` (executed), and the probe it must skip is
// still guarded by `HARNESS_CHECK` in the rendered output (structural -- not where the block sits,
// but whether the condition is on it, which is the thing an edit removes).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const RENDER = path.join(ROOT, "render.sh");

/** Hostile by construction: set, and pointing nowhere a service could answer from. */
const NOWHERE = "http://127.0.0.2:1";

function renderPi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-check-"));
  const out = path.join(dir, "pi-aify");
  // EVERY placeholder: render.sh refuses a partial substitution rather than shipping a launcher with
  // `@@...@@` still in it, which is the right call and means a test must supply them all.
  execFileSync("bash", [RENDER, "pi-aify.sh.in", out,
    `ENDPOINT=${NOWHERE}`, "REGISTRY_FINGERPRINT=test-fp", "SERVICE_NAME=aify-comms",
    "WRAPPER_VERSION=0.6.0"], { encoding: "utf8" });
  return { dir, out };
}

test("--check exits 0 and reports, with an agent id and an endpoint set", () => {
  const { dir, out } = renderPi();
  try {
    const result = spawnSync("bash", [out, "--check", "--aify-agent=sc-architect"], {
      encoding: "utf8",
      env: { ...process.env, AIFY_COMMS_URL: NOWHERE, AIFY_AGENT_ID: "sc-architect" },
    });
    assert.equal(
      result.status, 0,
      `--check exited ${result.status}. It answers a question about configuration and must not fail `
      + `on the state of a running agent.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    // AND IT REPORTED. Exiting 0 while printing nothing satisfies the assertion above and leaves the
    // operator with no answer, which is the half that actually happened on a bridge-owned agent.
    assert.match(result.stdout, /pi-aify /, "--check printed no report");
    assert.match(result.stdout, /nothing was started/i, "--check did not say it started nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the session-state probe is guarded by HARNESS_CHECK in the rendered launcher", () => {
  const { dir, out } = renderPi();
  try {
    const lines = fs.readFileSync(out, "utf8").split("\n");
    const probeAt = lines.findIndex((l) => l.includes("AIFY_WATCHDOG_URL="));
    assert.ok(probeAt > 0, "the session-state probe is not in the rendered launcher at all");

    // The condition governing it, which `render.sh` leaves as a continued line. Reading upward from
    // the probe rather than matching a fixed line number: the block moves, the guard is the subject.
    const condition = lines.slice(Math.max(0, probeAt - 4), probeAt).join(" ");
    assert.match(
      condition, /HARNESS_CHECK/,
      "the session-state probe is no longer gated on HARNESS_CHECK, so `pi-aify --check` calls the "
      + "service again -- and on a bridge-owned agent exits 1 before printing anything",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("and the probe is SKIPPED, not deleted", () => {
  // CONTRADICTION ARM. Removing the probe outright would satisfy both tests above and delete a
  // feature: without it a pi launch cannot discover that the bridge already drives this agent, and
  // two sessions end up on one agent id.
  const { dir, out } = renderPi();
  try {
    const text = fs.readFileSync(out, "utf8");
    assert.match(text, /pi-session-state/, "the session-state probe is gone, not merely skipped");
    assert.match(text, /bridgeOwned/, "the bridge-owned guard is gone, not merely skipped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
