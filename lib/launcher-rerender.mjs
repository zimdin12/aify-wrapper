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
import { compareTemplateSource } from "./template-source.mjs";
import { readRecords, recordDirFor } from "./render-record.mjs";
export { parseRecord, recordDirFor } from "./render-record.mjs";
import fs from "node:fs";
import path from "node:path";

import { launcherAliases, launcherNames } from "./launcher-names.mjs";
import { encodeRenderFrame } from "./render-frame.mjs";
import { fingerprint, mcpTransportFor, parseRegistry, sessionMcpConfigBase64, strictMcpFragmentBase64, strictMcpSecretProblem } from "./registry.mjs";
import { sessionCodexWordsBase64 } from "./session-codex.mjs";
import { sessionHttpBase64 } from "./session-http.mjs";
import { readRegistryPairCategories } from "./registry-pair-categories.mjs";

const LAUNCHER = /-aify$/;

/**
 * The launcher names a template here renders, and their aliases (lib/launcher-names.mjs), so a package's own bin that
 * happens to end in `-aify` (npm's `herdr-aify`) is not taken for an unrecorded launcher. Null when the templates
 * cannot be listed.
 */
function renderableNames(wrapperRoot) {
  try {
    return new Set(launcherNames(wrapperRoot));
  } catch {
    return null;
  }
}

/**
 * The pairs a registry decides, for `template` serving `service`; or the reason this registry cannot be given to it.
 * Names/categories come from the renderer's literal block. Client-specific calculation remains scoped to its
 * runtime; a service-declared transport overrides the recorded one, which otherwise decides own-service HTTP.
 */
export function registryPairs(registryText, template, env, service = "", recordedTransport = "") {
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
  try {
    return { pairs: readRegistryPairCategories().pairsFrom({
      REGISTRY_FINGERPRINT: fingerprint(parsed.registry),
      STRICT_EXTRA_MCP_B64: strictMcpFragmentBase64(parsed.registry),
      SESSION_MCP_B64: sessionMcpConfigBase64(parsed.registry),
      SESSION_HTTP_B64: sessionHttpBase64(parsed.registry, { own: (mcpTransportFor(parsed.registry, service) || recordedTransport) === "http" ? service : "" }),
      SESSION_MCP_CODEX_B64: codex,
      MCP_TRANSPORT: mcpTransportFor(parsed.registry, service),
    }) };
  } catch (error) {
    return { problem: error.message };
  }
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
  const aliases = launcherAliases(wrapperRoot);
  const rows = [];
  const handled = records.map((record) => record.target);
  for (const record of records) {
    const row = rerenderOne(record, { registryText, wrapperRoot, env, recordDir });
    rows.push(row);
    for (const alias of aliases.get(row.name) ?? []) {
      const target = path.join(path.dirname(record.target), alias);
      if (!fs.existsSync(target)) continue;
      handled.push(target);
      rows.push(followPrimary(row, record.target, target));
    }
  }
  let inDest = [];
  try {
    const renderable = renderableNames(wrapperRoot);
    inDest = fs.readdirSync(dest).filter((name) => (renderable ? renderable.has(name) : LAUNCHER.test(name)));
  } catch {
    // No launcher directory: nothing in it to report.
  }
  for (const name of inDest.sort()) {
    if (handled.some((target) => same(target, path.join(dest, name)))) continue;
    rows.push({ name, state: "stale", detail: "no render record; re-run the installer that wrote it" });
  }
  return rows;
}

/**
 * An alias goes with its launcher, as install.sh made it: a copy of the launcher just re-rendered, or reported stale with
 * a launcher that was not.
 */
function followPrimary(primaryRow, primaryTarget, aliasTarget) {
  const name = path.basename(aliasTarget);
  if (primaryRow.state !== "re-rendered") {
    return { name, state: "stale", detail: `a copy of ${primaryRow.name}, which was not re-rendered; re-run the installer that wrote it` };
  }
  // STAGED, THEN RENAMED OVER IT, as render.sh replaces a launcher: a bash running the old alias reads its script as
  // it goes, and a copy written into that file would change the script under it. The bytes are written owner-only
  // (a launcher can carry a secret) and take the launcher's own mode before the rename makes them findable.
  const staged = `${aliasTarget}.${process.pid}.staged`;
  try {
    fs.writeFileSync(staged, fs.readFileSync(primaryTarget), { mode: 0o700, flag: "wx" });
    fs.chmodSync(staged, fs.statSync(primaryTarget).mode & 0o777);
    fs.renameSync(staged, aliasTarget);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    return { name, state: "failed", detail: `copying ${primaryRow.name}: ${error.message}` };
  }
  return { name, state: "re-rendered", detail: `a copy of ${primaryRow.name}` };
}

function rerenderOne(record, { registryText, wrapperRoot, env, recordDir }) {
  const name = path.basename(record.target);
  if (compareTemplateSource({ wrapperRoot, template: record.template, templateSha: record.templateSha }).state !== "current") {
    return { name, state: "stale", detail: `rendered from another ${record.template}; re-run the installer that wrote it` };
  }
  const service = (record.pairs.find((pair) => pair.startsWith("SERVICE_NAME=")) ?? "").slice("SERVICE_NAME=".length);
  const transport = (record.pairs.find((pair) => pair.startsWith("MCP_TRANSPORT=")) ?? "").slice("MCP_TRANSPORT=".length);
  const fresh = registryPairs(registryText, record.template, env, service, transport);
  if (fresh.problem) return { name, state: "failed", detail: fresh.problem };
  const slashes = (p) => p.split(path.sep).join("/");
  // A recorded pair the registry now decides (a declared MCP_TRANSPORT) is replaced, not kept beside it: render.sh
  // records every pair it is given, so a kept copy grew the record by one on each re-render (review of 48f276ba).
  const decided = new Set(fresh.pairs.map((pair) => pair.slice(0, pair.indexOf("="))));
  const kept = record.pairs.filter((pair) => !decided.has(pair.slice(0, pair.indexOf("="))));
  const frame = encodeRenderFrame([slashes(path.join(wrapperRoot, "render.sh")), record.template, record.target, ...fresh.pairs, ...kept]);
  if (frame === null) return { name, state: "failed", detail: "render frame refused: embedded NUL or missing required input" };
  const run = spawnSync("bash", [slashes(path.join(wrapperRoot, "bin", "aify-render-frame.sh"))], {
    input: frame,
    encoding: "utf8",
    env: { ...env, RENDER_RECORD_DIR: recordDir },
    timeout: 120_000,
  });
  if (run.status !== 0) return { name, state: "failed", detail: (run.stderr || run.error?.message || `exit ${run.status}`).trim() };
  return { name, state: "re-rendered", detail: "" };
}
