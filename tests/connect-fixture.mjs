// What every connect test needs: a sealed host, a service that answers like one, and a way to run the real bin.
//
// THE HOST IS SEALED. HOME and USERPROFILE point at a fresh directory, so the credential store, the registry and the
// launchers are this test's own; every AIFY_* and HERDR_* variable the suite was started with is dropped, and the
// registry is passed with --registry. A connect test that reached the real ~/.aify would rewrite the operator's keys.
//
// THE BIN RUNS ASYNCHRONOUSLY, because the service it talks to lives in this process: a synchronous spawn would
// block the event loop the service answers on.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";

import { tupleDigest } from "../lib/service-spec.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "aify-wrapper-connect.mjs");
export const FAKE_ENV = path.join(ROOT, "tests", "fake-aify-env.mjs");
export const KEY = "k3y-of-the-service-0123456789abcdef";
//: aify-env's real credential command, when its checkout is here. Resolved BEFORE any HOME is sealed.
export const ENV_REPO = [process.env.AIFY_ENV_REPO, path.join(ROOT, "..", "aify-env"), path.join(os.homedir(), "projects", "aify-env")]
  .filter(Boolean).find((dir) => fs.existsSync(path.join(dir, "bin", "aify-env-credential.mjs"))) ?? "";

const fwd = (p) => p.split(path.sep).join("/");

/** A fresh host: its home, registry, launcher directory, and comms' bridge files where a file-set lives. */
export function makeHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-connect-host-"));
  const root = path.join(home, ".aify-comms", "mcp", "stdio");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "server.js"), "// the bridge\n");
  fs.writeFileSync(path.join(root, "claude-channel.js"), "// the channel\n");
  // A listed file nothing runs, and an unlisted one: the copy holds the commit's whole directory, and more.
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests", "a.test.js"), "// a test\n");
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "// installed\n");
  const host = {
    home,
    root: fwd(root),
    registry: path.join(home, ".aify", "services.json"),
    dest: path.join(home, ".local", "bin"),
    spy: path.join(home, "aify-env-calls.log"),
    keyFile: (value, name = "key") => {
      const file = path.join(home, `${name}.txt`);
      fs.writeFileSync(file, `${value}\n`);
      return file;
    },
    calls: () => (fs.existsSync(host.spy) ? fs.readFileSync(host.spy, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    refs: () => {
      const dir = path.join(home, ".aify", "credentials");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : [];
    },
    registryBytes: () => (fs.existsSync(host.registry) ? fs.readFileSync(host.registry) : Buffer.alloc(0)),
  };
  return host;
}

export const MANIFEST_PATH = "/.well-known/aify-service/artifacts/comms-bridge.manifest";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
//: The manifest each spec's hash names, so the service serves the text that hash binds.
export const MANIFESTS = new Map();

/** `sha256sum` text for `files` under `host.root`, as comms' spec builder writes it; `lines` replaces the computed ones. */
export function manifestFor(host, files = ["claude-channel.js", "server.js", "tests/a.test.js"], lines = null) {
  const LF = String.fromCharCode(10);
  const rows = lines ?? [...files].sort().map((file) => `${sha256(fs.readFileSync(path.join(host.root, file)))}  ${file}`);
  const text = rows.map((row) => `${row}${LF}`).join("");
  MANIFESTS.set(sha256(text), text);
  return { text, sha256: sha256(text) };
}

/**
 * Put a key into `host`'s store the way production does: aify-env's own `credential set`, so the file carries the
 * store's ACL. A plain write leaves the temp directory's inherited ACL, which the real `registry check` rightly reads
 * as CREDENTIAL_INSECURE. Only without the aify-env checkout does it fall back to writing the file.
 */
export function storeCredential(host, ref, value) {
  const cli = ENV_REPO && path.join(ENV_REPO, "bin", "aify-env-credential.mjs");
  if (cli) {
    const run = spawnSync(process.execPath, [cli, "set", "--service", "seed", "--stdin", `--ref=${ref}`],
      { input: `${value}\n`, env: { ...process.env, HOME: host.home, USERPROFILE: host.home }, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`seeding ${ref}: ${run.stderr}`);
    return;
  }
  const store = path.join(host.home, ".aify", "credentials");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, ref), `${value}\n`, { mode: 0o600 });
}

/** comms' spec, the shape the format owner froze, with its file-set bound to `host`'s bridge files. */
export function commsSpec(host, overrides = {}, manifest = manifestFor(host)) {
  const artifact = {
    id: "comms-bridge",
    kind: "file-set",
    source: { git: { repo: "zimdin12/aify-comms", revision: "a".repeat(40) } },
    sha256: manifest.sha256,
    manifest: { path: MANIFEST_PATH },
    entries: ["server.js", "claude-channel.js"],
  };
  return {
    specVersion: 1,
    name: "aify-comms",
    version: "0.9.8",
    fixed: { agentState: { path: "/api/v1/agent-state" }, endpointEnv: ["CLAUDE_MCP_SERVER_URL", "AIFY_SERVER_URL"], keyEnv: ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"] },
    artifacts: [artifact],
    mcp: [
      { name: "aify-comms", artifact: "comms-bridge", entry: "server.js" },
      { name: "aify-comms-channel", artifact: "comms-bridge", entry: "claude-channel.js" },
    ],
    secrets: [{ field: "credentialRef", required: true, probe: "api" }],
    verify: { health: { path: "/health" }, probes: { api: { path: "/api/v1/agents", header: "x-api-key" } } },
    ...overrides,
  };
}

/** The --approve flags for every non-pending artifact of `spec`, as the operator would pass them. */
export function approvals(spec) {
  return spec.artifacts.filter((a) => !a.source.pending).flatMap((a) => ["--approve", tupleDigest(a)]);
}

/**
 * A service. `answer(req, keyed)` may override any route: return {status, location?, body?}. `keyed` is "none",
 * "wrong" or "right" for the request's x-api-key. Every request is logged.
 */
export async function startService({ spec, answer = () => null, key = KEY } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const value = req.headers["x-api-key"];
    const keyed = value === undefined ? "none" : value === key ? "right" : "wrong";
    requests.push({ path: req.url, keyed });
    const custom = answer(req, keyed);
    const send = (status, body = "", headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
    };
    if (custom) {
      return send(custom.status, custom.body ?? "", {
        ...(custom.location ? { location: custom.location } : {}),
        ...(custom.type ? { "content-type": custom.type } : {}),
      });
    }
    if (req.url === "/.well-known/aify-service") return send(200, JSON.stringify(typeof spec === "function" ? spec() : spec));
    if (req.url === "/health") return send(200, "{}");
    if (req.url === MANIFEST_PATH) {
      const current = typeof spec === "function" ? spec() : spec;
      const text = MANIFESTS.get(current?.artifacts?.[0]?.sha256);
      return text ? send(200, text, { "content-type": "text/plain; charset=utf-8" }) : send(404);
    }
    if (req.url === "/api/v1/agents" || req.url === "/api/v1/settings/schema") return send(keyed === "right" ? 200 : 401, "{}");
    return send(404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The real bin against `host`, with the test double for aify-env. Resolves {status, stdout, stderr}. */
export function runConnect(host, args, { env = {}, input = "" } = {}) {
  const base = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(AIFY_|HERDR_|CLAUDE_|CODEX_)/i.test(name)) base[name] = value;
  }
  const childEnv = {
    ...base,
    HOME: host.home,
    USERPROFILE: host.home,
    AIFY_TEST_SPY: host.spy,
    ...(ENV_REPO ? { AIFY_ENV_REPO: ENV_REPO } : {}),
    // The opt-in real `registry check` (see fake-aify-env.mjs), carried through the AIFY_* seal above on purpose.
    ...(process.env.AIFY_TEST_REAL_REGISTRY ? { AIFY_TEST_REAL_REGISTRY: process.env.AIFY_TEST_REAL_REGISTRY } : {}),
    ...env,
  };
  const argv = [BIN, ...args, "--registry", host.registry, "--dest", host.dest, "--aify-env", FAKE_ENV, "--file-set-root", host.root, "--no-prompt"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
