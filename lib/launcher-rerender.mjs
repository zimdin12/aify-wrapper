// Re-rendering the launchers on a host after its registry changed, from what each was rendered with.
//
// A LAUNCHER IS RE-RENDERED ONLY FROM ITS OWN RECORD. render.sh leaves `.aify-render/<name>.args` beside every
// launcher it writes: the template's sha256, its name, and the pairs the installer chose. Re-rendering replays
// exactly those with the registry-derived four recomputed. A launcher with no record, or one rendered from a
// template other than the one this package holds, is reported stale and left alone: guessing another installer's
// bridge directory or hermes extras would rewrite a working launcher into a different one.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fingerprint, parseRegistry, sessionMcpConfigBase64, strictMcpFragmentBase64, strictMcpSecretProblem } from "./registry.mjs";
import { sessionCodexWordsBase64 } from "./session-codex.mjs";

export const RECORD_DIR = ".aify-render";
const LAUNCHER = /-aify$/;

/** The record's fields, or null for a missing or malformed one. */
export function parseRecord(bytes) {
  const fields = bytes.toString("utf8").split("\0");
  if (fields.pop() !== "" || fields.length < 2 || !/^[0-9a-f]{64}$/.test(fields[0])) return null;
  const [templateSha, template, ...pairs] = fields;
  if (!/^[a-z]+-aify\.sh\.in$/.test(template) || !pairs.every((pair) => /^[A-Z0-9_]+=/.test(pair))) return null;
  return { templateSha, template, pairs };
}

/** The four pairs a registry decides, for `template`; or the reason this registry cannot be given to it. */
export function registryPairs(registryText, template, env) {
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
    ],
  };
}

/**
 * Re-render every launcher in `dest` that has a record. Never throws for one launcher: each gets a row.
 *
 * @returns {{name: string, state: "re-rendered"|"stale"|"failed", detail: string}[]}
 */
export function rerenderLaunchers({ dest, registryPath, wrapperRoot, env = process.env }) {
  let names = [];
  try {
    names = fs.readdirSync(dest).filter((name) => LAUNCHER.test(name));
  } catch (error) {
    return error.code === "ENOENT" ? [] : [{ name: dest, state: "failed", detail: error.message }];
  }
  const registryText = fs.readFileSync(registryPath, "utf8");
  return names.sort().map((name) => {
    const target = path.join(dest, name);
    let record = null;
    try {
      record = parseRecord(fs.readFileSync(path.join(dest, RECORD_DIR, `${name}.args`)));
    } catch {
      // No record: rendered before records existed, or by a renderer that writes none.
    }
    if (!record) return { name, state: "stale", detail: "no render record; re-run the installer that wrote it" };
    const templatePath = path.join(wrapperRoot, "wrappers", record.template);
    let templateSha = "";
    try {
      templateSha = createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex");
    } catch {
      // This package has no such template.
    }
    if (templateSha !== record.templateSha) {
      return { name, state: "stale", detail: `rendered from another ${record.template}; re-run the installer that wrote it` };
    }
    const fresh = registryPairs(registryText, record.template, env);
    if (fresh.problem) return { name, state: "failed", detail: fresh.problem };
    const slashes = (p) => p.split(path.sep).join("/");
    const run = spawnSync("bash", [slashes(path.join(wrapperRoot, "render.sh")), record.template, slashes(target), ...record.pairs, ...fresh.pairs], {
      encoding: "utf8",
      env,
      timeout: 120_000,
    });
    if (run.status !== 0) return { name, state: "failed", detail: (run.stderr || run.error?.message || `exit ${run.status}`).trim() };
    return { name, state: "re-rendered", detail: "" };
  });
}
