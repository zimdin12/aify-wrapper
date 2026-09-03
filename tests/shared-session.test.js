// `--shared`, the flag that lets the host tier own a resident's terminal.
//
// THE HEADLINE OF v0.6.2, in the operator's words: a resident TUI hosted by aify-env so it can be
// watched from elsewhere and survives the terminal that started it. Today a resident is a child of
// the operator's shell and dies with it.
//
// THE SHAPE UNDER TEST is that the wrapper RELAUNCHES ITSELF through the host rather than building a
// command for it. What runs is then exactly what would have run -- including every step a wrapper
// does before launching, and every step added to it later -- and it passes the host's allowlist by
// being the very thing that allowlist exists for.
//
// AND THE DEFAULT PATH IS UNTOUCHED, which is the operator's constraint on this whole feature. Every
// assertion about "no flag" below is really an assertion that a normal `claude-aify` is not changed
// by any of this.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SHARED_FLAG,
  sharedStartRequest,
  wantsSharedSession,
  withoutSharedFlag,
} from "../lib/shared-session.mjs";

const LAUNCHER = "C:/Users/op/.local/bin/claude-aify";

test("the flag is recognised", () => {
  assert.equal(wantsSharedSession(["--shared"]), true);
  assert.equal(wantsSharedSession(["--aify-agent=sc-lead", "--shared"]), true);
});

test("NOTHING ELSE IS THE FLAG — the default path must not change", () => {
  // The operator's constraint on the entire feature: a normal run is byte-identical to today. A
  // prefix or substring test here would silently host sessions nobody asked to host.
  for (const args of [[], ["--resume", "abc"], ["--shared-memory"], ["shared"], ["--sharedx"], ["-shared"]]) {
    assert.equal(wantsSharedSession(args), false, `${JSON.stringify(args)} was read as --shared`);
  }
});

test("junk is not a flag", () => {
  for (const junk of [undefined, null, "not-an-array", 7, {}]) {
    assert.equal(wantsSharedSession(junk), false);
  }
});

test("EVERY occurrence is stripped, or the relaunch recurses", () => {
  // A flag passed twice is a typo, not a request to host a session inside a hosted session. Leaving
  // the second one makes this a fork bomb whose children are agent runtimes.
  assert.deepEqual(withoutSharedFlag(["--shared", "-r", "x", "--shared"]), ["-r", "x"]);
});

test("stripping keeps everything else, in order", () => {
  // The relaunched wrapper must receive precisely what the operator typed, minus the flag: order
  // matters to `--resume x` and to any passthrough the runtime parses positionally.
  assert.deepEqual(
    withoutSharedFlag(["--aify-agent=sc-lead", "--shared", "--resume", "abc", "--", "extra"]),
    ["--aify-agent=sc-lead", "--resume", "abc", "--", "extra"],
  );
  assert.deepEqual(withoutSharedFlag([]), []);
  assert.deepEqual(withoutSharedFlag(null), []);
});

test("the start request asks the host to run THIS WRAPPER", () => {
  const { body } = sharedStartRequest({
    launcher: LAUNCHER, args: ["--aify-agent=sc-lead"], cwd: "C:/work", service: "aify-comms",
  });
  assert.equal(body.launcher, LAUNCHER,
    "the request names something other than the wrapper, so what runs is a rebuilt guess");
  assert.deepEqual(body.args, ["--aify-agent=sc-lead"]);
  assert.equal(body.cwd, "C:/work");
});

test("the service travels as DATA, never as a branch", () => {
  // aify-env requires every process to have an owner, and the wrapper knows which service it was
  // rendered for. Nothing here may know what that service IS -- aify-dashboard's launchers will pass
  // their own, and this file must serve them without an edit.
  const { body } = sharedStartRequest({
    launcher: LAUNCHER, args: [], cwd: "/w", service: "aify-dashboard",
  });
  assert.equal(body.service, "aify-dashboard");
});

test("a missing launcher or service FAILS CLOSED and says which", () => {
  // Both are placeholders substituted at render time, so an empty one means the launcher was rendered
  // wrong. Without this the failure surfaces as a 400 from the host, which reads like the host is the
  // broken thing.
  assert.match(sharedStartRequest({ service: "s", cwd: "/w" }).error, /wrapper asking/);
  assert.match(sharedStartRequest({ launcher: LAUNCHER, cwd: "/w" }).error, /service/);
  assert.match(sharedStartRequest({ launcher: "   ", service: "s" }).error, /wrapper asking/);
  assert.equal(sharedStartRequest().error !== undefined, true, "no arguments at all resolved to a request");
});

test("a blank label is OMITTED, not sent empty", () => {
  // The host renders the label in its AGENT column. An empty string there reads as a process nobody
  // owns, rather than as one that has not been named yet.
  const { body } = sharedStartRequest({ launcher: LAUNCHER, service: "s", cwd: "/w", label: "  " });
  assert.equal("label" in body, false);

  const named = sharedStartRequest({ launcher: LAUNCHER, service: "s", cwd: "/w", label: "sc-lead" });
  assert.equal(named.body.label, "sc-lead");
});

test("args are strings, whatever a shell handed in", () => {
  // A wrapper passes `"$@"`, so anything can arrive. A number reaching the host as a number is a 400
  // on a field the operator cannot see.
  const { body } = sharedStartRequest({ launcher: LAUNCHER, service: "s", cwd: "/w", args: [1, null] });
  assert.deepEqual(body.args, ["1", "null"]);
});

test("the flag is spelled in ONE place", () => {
  // The parser and the stripper reading different constants is how a flag comes to be recognised and
  // not removed -- which is the recursion case above, arriving by a quieter route.
  assert.equal(SHARED_FLAG, "--shared");
  assert.equal(wantsSharedSession([SHARED_FLAG]), true);
  assert.deepEqual(withoutSharedFlag([SHARED_FLAG]), []);
});
