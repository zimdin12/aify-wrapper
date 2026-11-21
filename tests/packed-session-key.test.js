import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmCliBeside } from "../lib/npm-cli.mjs";
import { packCandidate, sha256 } from "../scripts/pack-wrapper-candidate.mjs";
import { makePrivate, ownerEnv } from "./private-credential.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// aify-comms 5402e292571a324e8ed721120c27846dea84d235:mcp/stdio/tests/fixtures/session-key-v1.json
const CONTRACT = "192fc56b9b6603b936d164ff09fbdacdf2e10fbdaf2d11a466f0bbbdce5159dc";
const WIN = process.platform === "win32";
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const SAMPLER = "fixture-other-service";
const OTHER_KEY = "separate-fixture-key-0123456789";

function requestedCandidate(dir) {
  const { AIFY_PACKED_WRAPPER_TARBALL: file, AIFY_PACKED_WRAPPER_SHA256: digest } = process.env;
  if (process.env.AIFY_REQUIRE_PACKED_WRAPPER === "1" || file !== undefined || digest !== undefined) {
    assert.ok(file && /^[0-9a-f]{64}$/.test(digest ?? ""), "release must supply both candidate path and SHA-256");
    return { file, digest };
  }
  const local = path.join(dir, "wrapper-candidate.tgz");
  return { file: local, digest: packCandidate(ROOT, local) };
}

function nodeRun(args, options = {}) {
  const run = spawnSync(process.execPath, args, { ...options, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.error?.message || run.stdout);
  return run.stdout.trim();
}

function setup(dir) {
  try {
    const fixtureBytes = fs.readFileSync(new URL("./fixtures/session-key-v1.json", import.meta.url));
    assert.equal(sha256(fixtureBytes), CONTRACT, "comms session-key fixture digest mismatch");
    const fixture = JSON.parse(fixtureBytes);
    assert.equal(fixture.schemaVersion, 1);
    const { file, digest } = requestedCandidate(dir);
    const bytes = fs.readFileSync(file);
    assert.equal(sha256(bytes), digest, "wrapper candidate SHA-256 mismatch");
    const tarball = path.join(dir, "verified.tgz");
    fs.writeFileSync(tarball, bytes, { flag: "wx" });
    const prefix = path.join(dir, "install");
    fs.mkdirSync(prefix);
    const npm = npmCliBeside(process.execPath);
    const cache = process.env.AIFY_TEST_NPM_CACHE;
    assert.ok(npm && cache, "the sealed runner must provide npm and the cache populated by npm ci");
    const installEnv = { ...process.env, NPM_CONFIG_USERCONFIG: path.join(dir, "empty-user-npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(dir, "empty-global-npmrc"), GIT_TERMINAL_PROMPT: "0" };
    nodeRun([npm, "install", "--prefix", prefix, "--global=false", "--offline", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, tarball],
      { cwd: prefix, env: installEnv });
    const modules = path.join(prefix, "node_modules");
    const wrapper = path.join(modules, "aify-wrapper");
    const receipt = json(path.join(prefix, "package-lock.json")).packages;
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    assert.equal(receipt["node_modules/aify-wrapper"].integrity, integrity, "npm installed a different wrapper artifact");
    const candidatePin = json(path.join(wrapper, "package.json")).dependencies["aify-env"];
    const lockedEnv = json(path.join(ROOT, "package-lock.json")).packages["node_modules/aify-env"].resolved;
    const revision = (spec) => /#([a-f0-9]{40})$/.exec(spec ?? "")?.[1];
    assert.ok(revision(candidatePin), "the installed wrapper must pin aify-env by exact Git revision");
    assert.equal(revision(candidatePin), revision(lockedEnv));
    assert.equal(revision(receipt["node_modules/aify-env"].resolved), revision(lockedEnv));
    return { wrapper, fixture, digest };
  } catch (error) {
    throw new Error(`NOT_RUN: packed session-key prerequisites: ${error.message}`, { cause: error });
  }
}

async function listener(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, key: req.headers["x-api-key"] });
    res.end("fixture receiver");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: String(server.address().port) };
}

function putCredential(home, ref, kind, contents) {
  if (kind === "missing") return;
  const store = path.join(home, ".aify", "credentials");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const makeLink = { symlink: fs.symlinkSync, hardlink: fs.linkSync }[kind];
  assert.ok(makeLink || kind === "private" || kind === "shared", `unknown fixture custody: ${kind}`);
  const credential = path.join(store, ref);
  const target = makeLink ? `${credential}.target` : credential;
  fs.writeFileSync(target, contents, { mode: 0o600 });
  makePrivate(target);
  if (makeLink) makeLink(target, credential);
  if (kind === "shared") {
    if (process.platform !== "win32") fs.chmodSync(credential, 0o644);
    else {
      const grant = spawnSync("icacls", [credential, "/grant", "*S-1-1-0:R"], { encoding: "utf8", windowsHide: true });
      assert.equal(grant.status, 0, `NOT_RUN: could not create the shared ACL control: ${grant.stderr}`);
    }
  }
}

function builtConfig(home, wrapper, fixture, registered, other, requested, item) {
  const { registration, store } = fixture;
  const registry = path.join(home, "services.json");
  fs.writeFileSync(registry, JSON.stringify({ version: 1, services: {
    [registration.name]: { ...registration.fixed, endpoint: registered, credentialRef: store.credentialRef },
    [SAMPLER]: { endpoint: other, mcpTransport: "http", sessionInject: { mcp: true }, credentialRef: "other.key" },
  } }));
  putCredential(home, store.credentialRef, item.custody, item.bytes ?? store.bytes);
  putCredential(home, "other.key", "private", `${OTHER_KEY}\n`);
  // No ambient service keys; the restricted PATH also exercises Windows' System32 ACL lookup.
  const env = { ...ownerEnv(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TEMP: home, TMP: home, TMPDIR: home, PATH: path.dirname(process.execPath),
    AIFY_AGENT_ID: "fixture-caller", ...item.request.env };
  const baked = nodeRun([path.join(wrapper, "lib", "registry-cli.mjs"), "session-http-b64", registry, registration.name], { env, cwd: home });
  assert.ok(baked, "the installed baker emitted no session input");
  const config = nodeRun([path.join(wrapper, "bin", "aify-session-mcp.mjs")], { cwd: home,
    env: { ...env, AIFY_SESSION_HTTP_B64: baked, AIFY_SESSION_ENDPOINT: requested } });
  return json(config).mcpServers;
}

function translated(url, oldPort, primary, other) {
  const result = new URL(url);
  result.port = result.port === oldPort ? primary.port : other.port;
  return result.href;
}

async function observe(entry, target, absolute, key, label) {
  assert.equal(entry.url, absolute, `${label}: rendered destination`);
  assert.equal(entry.type, "http");
  if (new URL(absolute).protocol === "https:") {
    // The fixture's scheme-change case shares the HTTP listener's port; check the TLS config without sending plaintext.
    assert.equal(entry.headers["X-API-Key"], key, `${label}: configured TLS key`);
    return;
  }
  const result = await fetch(entry.url, { redirect: "error", headers: entry.headers });
  assert.equal(await result.text(), "fixture receiver");
  assert.deepEqual(target.seen.splice(0), [{ path: new URL(absolute).pathname, key }], `${label}: outbound request sent the wrong key or path`);
}

test("the installed wrapper candidate follows the published session-key contract", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-packed-keys-"));
  const { wrapper, fixture, digest } = setup(dir);
  t.diagnostic(`packed wrapper SHA-256 ${digest}; platform ${process.platform}`);
  const primary = await listener(t);
  const other = await listener(t);
  const oldPort = new URL(fixture.store.endpoint).port;
  const registered = translated(fixture.store.endpoint, oldPort, primary, other);
  const sibling = `http://127.0.0.1:${other.port}/other-service`;
  const symlink = fixture.cases.find((item) => item.custody === "symlink");
  assert.ok(symlink, "the contract must cover POSIX symlink refusal");
  const cases = WIN ? fixture.cases.filter((item) => item !== symlink)
    : [...fixture.cases, { ...symlink, id: "hard-link", custody: "hardlink" }];
  for (const item of cases) {
    await t.test(item.id, async () => {
      const home = fs.mkdtempSync(path.join(dir, "home-"));
      const requested = translated(item.request.url ?? fixture.store.endpoint, oldPort, primary, other);
      const target = new URL(requested).port === primary.port ? primary : other;
      const config = builtConfig(home, wrapper, fixture, registered, sibling, requested, item);
      assert.deepEqual(Object.keys(config).sort(), [fixture.registration.name, SAMPLER].sort());
      // Wrapper normalizes the accepted loopback spelling as well as appending the tool path.
      const url = `${requested.replace("http://localhost:", "http://127.0.0.1:").replace(/\/$/, "")}/mcp/http`;
      assert.ok(item.expected.refused === true || typeof item.expected.key === "string");
      await observe(config[fixture.registration.name], target, url, item.expected.key, item.id);
      await observe(config[SAMPLER], other, `${sibling}/mcp/http`, OTHER_KEY, "sibling keeps its own key");
      assert.deepEqual(primary.seen, []);
      assert.deepEqual(other.seen, []);
    });
  }
  await t.test("endpoint equivalence uses the installed adapter", () => {
    const adapter = pathToFileURL(path.join(wrapper, "lib", "session-http.mjs")).href;
    const code = `import { sameEndpoint } from ${JSON.stringify(adapter)};
      process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(({left,right}) => sameEndpoint(left,right))));`;
    assert.deepEqual(JSON.parse(nodeRun(["--input-type=module", "-e", code, JSON.stringify(fixture.endpointCases)])),
      fixture.endpointCases.map(({ same }) => same));
  });
});
