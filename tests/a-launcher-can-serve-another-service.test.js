// The launchers name a service, and that name is a parameter.
//
// The contract was always generic -- every variable is HARNESS_*, not AIFY_COMMS_* -- but the rendered
// bodies hardcoded one service in executable lines: the MCP server key, the channel server, the flag
// that loads that channel, and codex's log root. So aify-wrapper could only ever install launchers for
// aify-comms, while aify-env alongside it is genuinely service-agnostic (zero dependencies, and every
// mention of aify-comms in it is a comment).
//
// ONE parameter, and the channel is DERIVED from it. Two names that must agree are a defect with a
// delay on it.
//
// WHAT IS NOT PARAMETERISED, deliberately: the paths. `~/.aify-comms` appears in a rendered launcher as
// the place THAT service's runtime lives, and it already comes from --bridge-dir / NATIVE_BASE. A
// different service passes a different directory. Identity and location are different axes and only
// identity was missing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const posix = (p) => p.split(String.fromCharCode(92)).join("/");

function render(extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-service-"));
  const result = spawnSync("bash", [
    INSTALL, "--all", "--endpoint", "http://127.0.0.2:1", ...extra, "--render-only", posix(dir),
  ], { encoding: "utf8", timeout: 180_000 });
  return { dir, result };
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");
/** Executable lines only: a comment naming a service is documentation, not wiring. */
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line));

test("the default render still names aify-comms, everywhere it used to", () => {
  // The point of the default is that this change is invisible to every existing install.
  const { dir, result } = render();
  assert.equal(result.status, 0, result.stderr);
  const claude = read(dir, "claude-aify");
  assert.ok(claude.includes('\\"aify-comms\\": { \\"type'), "the sse entry lost the default name");
  assert.ok(claude.includes('\\"aify-comms\\": { \\"command'), "the stdio entry lost the default name");
  assert.ok(claude.includes("aify-comms-channel"), "the channel server lost its name");
  assert.ok(claude.includes("server:aify-comms-channel"), "the flag that loads the channel lost its name");
  // Matched on the LOG_ROOT line itself: the rendered text is `.local/state}/aify-comms`, with a
  // closing brace before the slash, so a naive "state/aify-comms" never appears.
  assert.match(read(dir, "codex-aify"), /^LOG_ROOT=.*\/aify-comms"$/m, "codex's log root moved");
});

test("--service renames the MCP server, its channel, and the flag that loads it", () => {
  const { dir, result } = render(["--service", "my-service"]);
  assert.equal(result.status, 0, result.stderr);
  const claude = read(dir, "claude-aify");
  assert.ok(claude.includes('\\"my-service\\": { \\"type\\"'), "the sse entry kept the old name");
  assert.ok(claude.includes('\\"my-service\\": { \\"command\\"'), "the stdio entry kept the old name");
  assert.ok(claude.includes('"my-service-channel"'), "the channel is not derived from the service");
  assert.ok(claude.includes("server:my-service-channel"), "the launch flag kept the old channel");
});

test("the channel is derived, so it can never disagree with the service", () => {
  const { dir } = render(["--service", "svc-two"]);
  const claude = read(dir, "claude-aify");
  const channels = [...claude.matchAll(/"([a-z0-9_-]+)-channel"/g)].map((m) => m[1]);
  assert.ok(channels.length > 0, "no channel server was rendered at all");
  assert.deepEqual([...new Set(channels)], ["svc-two"], `channels disagree: ${channels}`);
});

test("codex's log root follows the service", () => {
  const { dir } = render(["--service", "svc-three"]);
  assert.match(read(dir, "codex-aify"), /^LOG_ROOT=.*\/svc-three"$/m);
});

test("NO executable line names aify-comms once another service is asked for -- paths included", () => {
  // No exception. Until the NATIVE_BASE default was derived, this excused every `.aify-comms` path,
  // which is exactly where the bug lived: a launcher for svc-four pointing at aify-comms' runtime
  // directory passed the old assertion BY DESIGN.
  const { dir } = render(["--service", "svc-four"]);
  for (const name of ["claude-aify", "codex-aify", "hermes-aify"]) {
    const offenders = codeLines(read(dir, name))
      .filter((line) => line.includes("aify-comms"));
    assert.deepEqual(offenders, [], `${name} still wires aify-comms:\n${offenders.join("\n")}`);
  }
});

test("a name that is not safe in JSON and shell is refused, not rendered", () => {
  // It lands in a JSON key AND a shell word. Refusing costs nothing; the alternative is a launcher
  // that breaks when it is read.
  for (const bad of ["bad name!", 'quote"inside', "semi;colon", ""]) {
    const { result } = render(["--service", bad]);
    assert.equal(result.status, 78, `${JSON.stringify(bad)} was accepted: ${result.stdout}`);
  }
});

test("the contract variables are named for the harness, not for any one service", () => {
  // The half that was already right, asserted so it stays that way: a launcher for another service
  // must not have to learn aify-comms' vocabulary.
  const { dir } = render(["--service", "svc-five"]);
  const claude = read(dir, "claude-aify");
  for (const name of ["HARNESS_ENDPOINT", "HARNESS_WRAPPER_VERSION", "HARNESS_REGISTRY_FINGERPRINT"]) {
    assert.ok(claude.includes(name), `${name} is missing from a rendered launcher`);
  }
  assert.ok(!claude.includes("AIFY_COMMS_ENDPOINT"), "a service-specific contract variable appeared");
});

test("the runtime directory DEFAULTS to the service's own, not to a neighbour's", () => {
  // The positive half. Asserting an ABSENCE above says nothing about whether the right path
  // arrived: a render that produced no bridge directory at all would satisfy it and break every
  // launcher it wrote.
  const { dir } = render(["--service", "svc-six"]);
  const claude = codeLines(read(dir, "claude-aify")).join("\n");
  assert.match(claude, /\.svc-six\/mcp\/stdio/, "the bridge directory does not follow the service");
});

test("--native-base still wins, because location is its own axis", () => {
  // The decision this change did NOT reverse. A service whose runtime lives somewhere else says so,
  // and a derived default must never quietly override an explicit answer.
  const { dir } = render(["--service", "svc-seven", "--native-base", "/tmp/elsewhere"]);
  const claude = codeLines(read(dir, "claude-aify")).join("\n");
  assert.match(claude, /\/tmp\/elsewhere\/mcp\/stdio/, "an explicit --native-base was ignored");
  assert.ok(!claude.includes(".svc-seven"), "the derived default overrode an explicit --native-base");
});

test("THE DEFAULT SERVICE STILL LANDS IN ~/.aify-comms, exactly as before", () => {
  // The safety property of the whole change: SERVICE_NAME defaults to aify-comms, so the derived
  // path is the literal it replaced and no existing install moves. Proven by rendering rather than
  // by reasoning about what the substitution ought to produce.
  const { dir } = render();
  assert.match(codeLines(read(dir, "claude-aify")).join("\n"), /\.aify-comms\/mcp\/stdio/,
    "the default render's runtime directory moved, which would relocate every existing install");
});
