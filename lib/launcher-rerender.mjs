// Re-rendering the launchers on a host after its registry changed, from what each was rendered with.
//
// A LAUNCHER IS RE-RENDERED ONLY FROM ITS OWN RECORD. An installer that asks (RENDER_RECORD_DIR; install.sh names
// `launchers/` beside the registry) gets one record per launcher from render.sh: the template's sha256, its name, the
// launcher's path and the pairs the installer chose. Re-rendering replays exactly those with the registry-derived pairs
// recomputed and passed first, so a transport the service declares (`mcpTransport`) wins over the recorded one. A launcher with no record, or one rendered from a template other than the one this package holds, is
// reported stale and left alone: guessing another installer's bridge directory or hermes extras would rewrite a
// working launcher into a different one.
//
// THE RECORDS LIVE BESIDE THE REGISTRY, never in the launcher directory: that directory is on PATH, and every file
// in it is something a shell may find.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fingerprint, mcpTransportFor, parseRegistry, sessionMcpConfigBase64, strictMcpFragmentBase64, strictMcpSecretProblem } from "./registry.mjs";
import { sessionCodexWordsBase64 } from "./session-codex.mjs";

const LAUNCHER = /-aify$/;

/**
 * The launcher names a template here renders (`wrappers/<name>.sh.in`), so a package's own bin that happens to end in
 * `-aify` (npm's `herdr-aify`) is not taken for an unrecorded launcher. Null when the templates cannot be listed.
 */
function renderableNames(wrapperRoot) {
  try {
    return new Set(fs.readdirSync(path.join(wrapperRoot, "wrappers")).filter((name) => name.endsWith(".sh.in")).map((name) => name.slice(0, -".sh.in".length)));
  } catch {
    return null;
  }
}

/** Where an installer's render records for `registryPath` live. */
export function recordDirFor(registryPath) {
  return path.join(path.dirname(registryPath), "launchers");
}

/** The record's fields, or null for a missing or malformed one. */
export function parseRecord(bytes) {
  const fields = bytes.toString("utf8").split("\0");
  if (fields.pop() !== "" || fields.length < 3 || !/^[0-9a-f]{64}$/.test(fields[0])) return null;
  const [templateSha, template, targetPair, ...pairs] = fields;
  if (!/^[a-z]+-aify\.sh\.in$/.test(template) || !targetPair.startsWith("TARGET=") || !pairs.every((pair) => /^[A-Z0-9_]+=/.test(pair))) return null;
  return { templateSha, template, target: targetPair.slice("TARGET=".length), pairs };
}

/**
 * The pairs a registry decides, for `template` serving `service`; or the reason this registry cannot be given to it.
 * The four always, and MCP_TRANSPORT when the service declares one.
 */
export function registryPairs(registryText, template, env, service = "") {
  const parsed = parseRegistry(registryText);
  if (!parsed.ok) return { problem: `the registry does not parse: ${parsed.errors.join("; ")}` };
  const secret = strictMcpSecretProblem(parsed.registry, env);
  if (secret) return { problem: secret };
  let codex = "";
  if (template === "codex-aify.sh.in") {
    const words = sessionCodexWordsBase64(parsed.registry);
    if (!words.ok) return { problem: words.problems.join("; ") };
    codex = words.value;
  }
  return {
    pairs: [
      `REGISTRY_FINGERPRINT=${fingerprint(parsed.registry)}`,
      `STRICT_EXTRA_MCP_B64=${strictMcpFragmentBase64(parsed.registry)}`,
      `SESSION_MCP_B64=${sessionMcpConfigBase64(parsed.registry)}`,
      `SESSION_MCP_CODEX_B64=${codex}`,
      ...(mcpTransportFor(parsed.registry, service) ? [`MCP_TRANSPORT=${mcpTransportFor(parsed.registry, service)}`] : []),
    ],
  };
}

function readRecords(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".args"));
  } catch {
    return [];
  }
  return names.map((name) => {
    try {
      return parseRecord(fs.readFileSync(path.join(dir, name)));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

//: Windows paths compare without case; POSIX ones do not.
const fold = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const same = (a, b) => fold(a) === fold(b);

/**
 * Re-render every recorded launcher that still exists, and report every launcher in `dest` with no record as stale.
 * Never throws for one launcher: each gets a row.
 *
 * @returns {{name: string, state: "re-rendered"|"stale"|"failed", detail: string}[]}
 */
export function rerenderLaunchers({ dest, registryPath, wrapperRoot, env = process.env }) {
  const recordDir = recordDirFor(registryPath);
  const records = readRecords(recordDir).filter((record) => fs.existsSync(record.target));
  const registryText = records.length ? fs.readFileSync(registryPath, "utf8") : "";
  const rows = records.map((record) => rerenderOne(record, { registryText, wrapperRoot, env, recordDir }));
  let inDest = [];
  try {
    const renderable = renderableNames(wrapperRoot);
    inDest = fs.readdirSync(dest).filter((name) => (renderable ? renderable.has(name) : LAUNCHER.test(name)));
  } catch {
    // No launcher directory: nothing in it to report.
  }
  for (const name of inDest.sort()) {
    if (records.some((record) => same(record.target, path.join(dest, name)))) continue;
    rows.push({ name, state: "stale", detail: "no render record; re-run the installer that wrote it" });
  }
  return rows;
}

function rerenderOne(record, { registryText, wrapperRoot, env, recordDir }) {
  const name = path.basename(record.target);
  let templateSha = "";
  try {
    templateSha = createHash("sha256").update(fs.readFileSync(path.join(wrapperRoot, "wrappers", record.template))).digest("hex");
  } catch {
    // This package has no such template.
  }
  if (templateSha !== record.templateSha) {
    return { name, state: "stale", detail: `rendered from another ${record.template}; re-run the installer that wrote it` };
  }
  const service = (record.pairs.find((pair) => pair.startsWith("SERVICE_NAME=")) ?? "").slice("SERVICE_NAME=".length);
  const fresh = registryPairs(registryText, record.template, env, service);
  if (fresh.problem) return { name, state: "failed", detail: fresh.problem };
  const slashes = (p) => p.split(path.sep).join("/");
  const run = spawnSync("bash", [slashes(path.join(wrapperRoot, "render.sh")), record.template, record.target, ...fresh.pairs, ...record.pairs], {
    encoding: "utf8",
    env: { ...env, RENDER_RECORD_DIR: recordDir },
    timeout: 120_000,
  });
  if (run.status !== 0) return { name, state: "failed", detail: (run.stderr || run.error?.message || `exit ${run.status}`).trim() };
  return { name, state: "re-rendered", detail: "" };
}
