#!/usr/bin/env node
// codex-aify hands the servers opted into every session ("sessionInject": {"mcp": true}) to the APP-SERVER, as
// the `-c mcp_servers.<name>.*` words `registry-cli.mjs session-codex-b64` builds at install. Observed on codex-cli
// 0.159.3 (app-server JSON-RPC, mcpServerStatus/list): `-c mcp_servers...` loads the server, and `env_vars` is
// what forwards AIFY_AGENT_ID to it. Rendered by install.sh against the run's own registry and executed to a stub
// codex that records the app-server's argv NUL-separated, so a word holding a newline is still one word here.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRegistry } from "../lib/registry.mjs";
import { sessionCodexWordsBase64 } from "../lib/session-codex.mjs";
import { launch } from "./launch-to-a-stub-runtime.mjs";

const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);
// Everything a word-splitting or re-evaluating decode would mangle: a space, double quotes, a newline, a command
// substitution, backticks and a Windows backslash.
const HOSTILE = `--note=a "b"${LF}$(touch PWNED) \`x\` C:${BS}y`;

const REGISTRY = {
  version: 1,
  services: {
    "aify-dashboard": {
      endpoint: "http://127.0.0.2:9700",
      credentialRef: "aify-dashboard.key",
      sessionInject: { mcp: true },
      mcp: [{ name: "aify-dashboard", command: "node", args: ["C:/a b/bridge.mjs", HOSTILE] }],
    },
  },
};

/** The `-c` values in an argv, in order, up to the subcommand. */
const configValues = (argv) => argv.slice(0, argv.indexOf("app-server")).flatMap((a, i, all) => (all[i - 1] === "-c" ? [a] : []));
const sessionValues = (argv) => configValues(argv).filter((value) => value.startsWith("mcp_servers."));

test("an opted-in server reaches the app-server as three -c words, each arriving as ONE word whatever it holds", () => {
  // The bug this catches: decoding the words in a way that splits or re-evaluates them (a `$(...)` round trip, an
  // unquoted expansion, a newline separator). The hostile argument would then arrive as several words, or run.
  const { run, appServerArgs } = launch("codex", [], { registry: REGISTRY });
  assert.equal(run.status, 0, `${run.stdout}${LF}${run.stderr}`);
  // Written out by hand rather than computed by the verb, so this cannot agree with a wrong encoding.
  assert.deepEqual(sessionValues(appServerArgs), [
    'mcp_servers.aify-dashboard.command="node"',
    `mcp_servers.aify-dashboard.args=["C:/a b/bridge.mjs", "--note=a ${BS}"b${BS}"${BS}u000a$(touch PWNED) \`x\` C:${BS}${BS}y"]`,
    'mcp_servers.aify-dashboard.env_vars=["AIFY_AGENT_ID"]',
  ]);
});

test("with nothing opted in, the app-server is given no mcp_servers word", () => {
  // The control for the test above: the same launch against the run's empty registry. A launcher that adds a
  // server regardless shows up here. A harness reading this machine's registry would too, but only on a machine
  // whose registry opts a service in.
  const { run, appServerArgs } = launch("codex", []);
  assert.equal(run.status, 0, `${run.stdout}${LF}${run.stderr}`);
  assert.ok(appServerArgs.includes("app-server"), "the stub app-server never recorded its argv");
  assert.deepEqual(sessionValues(appServerArgs), []);
});

test("a launcher whose session words do not decode refuses to start, rather than starting without its servers", () => {
  // The bug this catches: reading the words from a process substitution, whose failure nothing sees, so the agent
  // starts quietly with none of the servers it was installed with.
  const parsed = parseRegistry(JSON.stringify(REGISTRY));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  const encoded = sessionCodexWordsBase64(parsed.registry);
  assert.equal(encoded.ok, true);
  const { run, appServerArgs } = launch("codex", [], {
    registry: REGISTRY,
    edit: (text) => {
      assert.ok(text.includes(encoded.value), "the rendered launcher does not carry the installer's value");
      return text.split(encoded.value).join("!!not-base64!!");
    },
  });
  assert.equal(run.status, 78, `${run.stdout}${LF}${run.stderr}`);
  assert.match(run.stderr, /session MCP servers do not decode/);
  assert.deepEqual(appServerArgs, [], "the app-server was started anyway");
});
