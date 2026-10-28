#!/usr/bin/env node
// The key a session entry carries is the key aify-comms' own resolver would choose (destinationKeyResolver): an
// exported key first, else the credential aify-env holds, only for the endpoint the registry names it for, and only
// from a file aify-env's custody rules accept. The wrapper applies that rule per service from the registry
// (lib/session-http.mjs sessionKey, lib/credential-file.mjs, lib/credential-custody.mjs) instead of importing comms,
// which pins this package; this file is what keeps the two from drifting apart.
//
// AGAINST THE REAL THING: comms' modules are imported from AIFY_COMMS_REPO and run on the same files. Test-only: no
// runtime path imports comms. FAILS, never skips, without AIFY_COMMS_REPO, because a cross-repo proof that quietly
// does not run is worse than none.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { makePrivate, writePrivateCredential } from "./private-credential.mjs";

import { custodyProblem, icaclsPath } from "../lib/credential-custody.mjs";
import { credentialRead } from "../lib/credential-file.mjs";
import { parseRegistry } from "../lib/registry.mjs";
import { sameEndpoint, sessionHttpServices, sessionKey } from "../lib/session-http.mjs";

const COMMS_REPO = process.env.AIFY_COMMS_REPO || "";
assert.ok(COMMS_REPO && fs.existsSync(path.join(COMMS_REPO, "mcp", "stdio", "aify-service-endpoint.mjs")),
  "AIFY_COMMS_REPO must name an aify-comms checkout: this test holds the wrapper's key rule to comms' resolver");
const stdio = (file) => pathToFileURL(path.join(COMMS_REPO, "mcp", "stdio", file)).href;
const { destinationKeyResolver, API_KEY_ENV_NAMES } = await import(stdio("aify-service-endpoint.mjs"));
const { sameEndpoint: commsSameEndpoint } = await import(stdio("registry-credential.mjs"));
const { custodyProblem: commsCustodyProblem } = await import(stdio("credential-custody.mjs"));

const ENDPOINT = "http://127.0.0.1:8800";
const KEY = "credential-key-for-this-test-only-0123456789";
const EXPORTED = "exported-key-for-this-test-only-0123456789";
const WIN = process.platform === "win32";

/** A home holding a registry for aify-comms (as comms' installer writes it) and, unless told otherwise, its credential. */
function fixture({ credential = "private" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-key-parity-"));
  const registry = {
    version: 1,
    services: {
      "aify-comms": { endpoint: ENDPOINT, keyEnv: API_KEY_ENV_NAMES, credentialRef: "aify-comms.key", mcp: [{ name: "aify-comms", command: "node", args: ["/b/server.js"] }] },
      "aify-dashboard": { endpoint: "http://127.0.0.1:9700", credentialRef: "aify-dashboard.key", sessionInject: { mcp: true }, mcpTransport: "http", mcp: [{ name: "aify-dashboard", command: "node", args: ["/d.js"] }] },
    },
  };
  fs.mkdirSync(path.join(home, ".aify", "credentials"), { recursive: true });
  fs.writeFileSync(path.join(home, ".aify", "services.json"), JSON.stringify(registry));
  const file = path.join(home, ".aify", "credentials", "aify-comms.key");
  if (credential === "private") writePrivateCredential(home, "aify-comms.key", KEY);
  if (credential === "malformed") makePrivate((fs.writeFileSync(file, KEY), file)); // no trailing newline
  if (credential === "shared") {
    fs.writeFileSync(file, `${KEY}\n`);
    if (WIN) execFileSync("icacls", [file, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true }); // Everyone
    else fs.chmodSync(file, 0o644);
  }
  if (credential === "link") {
    const real = writePrivateCredential(home, "elsewhere.key", KEY);
    fs.symlinkSync(real, file); // EPERM on a Windows account without the symlink privilege: the case skips by name
  }
  writePrivateCredential(home, "aify-dashboard.key", "dashboard-key-for-this-test-only-0123456789");
  return { home, registry: parseRegistry(JSON.stringify(registry)).registry };
}

/** Both answers for aify-comms, sending to `url` with `env`. */
async function both({ home, registry }, { url = ENDPOINT, env = {} } = {}) {
  const commsKey = destinationKeyResolver(ENDPOINT, { env, homeDir: home, onDiagnostic: () => {} })(url);
  const [service] = sessionHttpServices(registry, { own: "aify-comms" });
  const ours = await sessionKey(service, { url, env, read: (ref) => credentialRead(ref, { home }) });
  return { comms: commsKey, ours: ours.key, refused: ours.refused };
}

test("the fixture declares the names comms reads an exported key from", () => {
  // Bug this catches: comms reading a new name the registry does not declare, so an exported key wins in one and not the other.
  assert.deepEqual(API_KEY_ENV_NAMES, ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"]);
});

const CASES = [
  ["nothing exported: the credential", {}, {}, KEY],
  ["an exported key wins over the credential", {}, { env: { AIFY_API_KEY: EXPORTED } }, EXPORTED],
  ["a launch pointed elsewhere gets no credential", {}, { url: "http://127.0.0.1:8801" }, ""],
  ["a localhost spelling of the same endpoint still gets it", {}, { url: "http://localhost:8800/" }, KEY],
  ["a malformed credential is no key", { credential: "malformed" }, {}, ""],
  ["a credential others can read is no key", { credential: "shared" }, {}, ""],
  ["a credential reached through a link is no key", { credential: "link" }, {}, ""],
];
for (const [name, setup, launch, expected] of CASES) {
  test(`same key as comms: ${name}`, async (t) => {
    let home;
    try {
      home = fixture(setup);
    } catch (error) {
      if (error.code === "EPERM" && setup.credential === "link") return t.skip("this account cannot create a symlink (EPERM): the link case is NOT verified on this host");
      throw error;
    }
    try {
      const { comms, ours, refused } = await both(home, launch);
      assert.equal(comms, expected, "comms' resolver itself did not give what this case expects; the fixture is wrong");
      assert.equal(ours, comms, `the wrapper chose differently (${refused})`);
      if (!ours) assert.ok(refused, "no key, and no reason given");
    } finally {
      fs.rmSync(home.home, { recursive: true, force: true });
    }
  });
}

test("a service that declares no key variable never takes an exported key, where comms' resolver would hand it over", async () => {
  // Bug this catches: an exported comms key in another service's X-API-Key header. Comms' resolver applies an exported
  // key wherever it is pointed, which is right for comms' own process and wrong for a second service's entry.
  const home = fixture();
  try {
    const env = { AIFY_API_KEY: EXPORTED };
    const dashboard = sessionHttpServices(home.registry).find((service) => service.name === "aify-dashboard");
    const ours = await sessionKey(dashboard, { url: dashboard.endpoint, env, read: (ref) => credentialRead(ref, { home: home.home }) });
    assert.equal(ours.key, "dashboard-key-for-this-test-only-0123456789");
    assert.equal(destinationKeyResolver(dashboard.endpoint, { env, homeDir: home.home, onDiagnostic: () => {} })(dashboard.endpoint), EXPORTED,
      "control: comms' resolver no longer applies an exported key everywhere, so this difference may be gone");
  } finally {
    fs.rmSync(home.home, { recursive: true, force: true });
  }
});

test("custodyProblemFor reads a real file's custody on this host: private passes, shared is refused", async () => {
  // The gather, not only the judgement: icacls by its system path on Windows (a launch's PATH may lack System32), lstat
  // and the mode on POSIX. A sealed PATH is the case that refused every key before.
  // In a child whose PATH holds only node's folder, as in a sealed launch: the lookup is the process's own PATH.
  const module = new URL("../lib/credential-custody.mjs", import.meta.url).href;
  const custodyOf = (file) => execFileSync(process.execPath, ["--input-type=module", "-e",
    `const { custodyProblemFor } = await import(${JSON.stringify(module)}); process.stdout.write(await custodyProblemFor(process.argv[1]));`, file],
  { encoding: "utf8", env: { ...process.env, PATH: path.dirname(process.execPath) } });
  // No system root named, no icacls guessed at: the ACL is then unreadable and the check refuses.
  assert.equal(icaclsPath({}), "");
  assert.equal(path.basename(icaclsPath({ SystemRoot: "X:\\Win" })), "icacls.exe");
  const home = fixture();
  try {
    const file = path.join(home.home, ".aify", "credentials", "aify-comms.key");
    assert.equal(custodyOf(file), "");
    if (WIN) execFileSync("icacls", [file, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
    else fs.chmodSync(file, 0o644);
    assert.match(custodyOf(file), /readable by|grants access beyond/);
  } finally {
    fs.rmSync(home.home, { recursive: true, force: true });
  }
});

test("endpoints compare as comms compares them", () => {
  const pairs = [
    ["http://localhost:8800", "http://127.0.0.1:8800/"], ["http://127.0.0.1", "http://127.0.0.1:80"], ["https://h", "https://h:443"],
    ["http://h:1/a", "http://h:1/b"], ["http://h:1/a/", "http://h:1/a"], ["not a url", "not a url"], ["", ""], ["http://h:1", "https://h:1"],
  ];
  for (const [a, b] of pairs) assert.equal(sameEndpoint(a, b), commsSameEndpoint(a, b), `${a} vs ${b}`);
});

test("custody is judged as comms judges it, for Windows ACLs and POSIX modes alike", () => {
  // The pure judgement over one corpus, so both platforms' rules are compared on whichever host runs this.
  const file = (over = {}) => ({ isSymbolicLink: () => false, isFile: () => true, size: 40, nlink: 1, uid: 1000, mode: 0o100600, ...over });
  const acl = (lines) => `C:\\k ${lines.join("\n     ")}\nSuccessfully processed 1 files; Failed processing 0 files\n`;
  const corpus = [
    { platform: "linux", stats: file(), uid: 1000 },
    { platform: "linux", stats: file({ mode: 0o100644 }), uid: 1000 },
    { platform: "linux", stats: file({ nlink: 2 }), uid: 1000 },
    { platform: "linux", stats: file({ uid: 0 }), uid: 1000 },
    { platform: "linux", stats: file({ isSymbolicLink: () => true }), uid: 1000 },
    { platform: "linux", stats: file({ isFile: () => false }), uid: 1000 },
    { platform: "linux", stats: file({ size: 5000 }), uid: 1000 },
    { platform: "linux", stats: null },
    { platform: "win32", stats: file(), owner: "HOST\\me", aclPath: "C:\\k", aclText: acl(["HOST\\me:(F)", "NT AUTHORITY\\SYSTEM:(F)"]) },
    { platform: "win32", stats: file(), owner: "HOST\\me", aclPath: "C:\\k", aclText: acl(["HOST\\me:(F)", "BUILTIN\\Administrators:(I)(F)"]) },
    { platform: "win32", stats: file(), owner: "HOST\\me", aclPath: "C:\\k", aclText: acl(["HOST\\me:(F)", "Everyone:(R)"]) },
    { platform: "win32", stats: file(), owner: "HOST\\me", aclPath: "C:\\k", aclText: "" },
    { platform: "win32", stats: file(), owner: "", aclPath: "C:\\k", aclText: acl(["HOST\\me:(F)"]) },
  ];
  for (const input of corpus) assert.equal(custodyProblem(input), commsCustodyProblem(input), JSON.stringify({ ...input, stats: input.stats && { ...input.stats } }));
  assert.ok(corpus.some((input) => custodyProblem(input) === ""), "positive control: nothing in the corpus passes");
  assert.ok(corpus.some((input) => custodyProblem(input) !== ""), "negative control: nothing in the corpus is refused");
});
