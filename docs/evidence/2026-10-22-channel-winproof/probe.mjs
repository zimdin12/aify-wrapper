// Runs the channel policy's registry adapters and its merge against a SCRATCH key on the real Windows registry.
// Never touches HKCU\SOFTWARE\Policies\ClaudeCode or any HKLM key. Usage: node probe.mjs [repo-root]
// Prints one line per case: PASS/FAIL <case> <detail>. Exit 0 only when every case passes.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] || ".");
const policy = await import(pathToFileURL(path.join(root, "lib", "channel-policy.mjs")).href);
const { readRegistrySettings, writeRegistrySettings, removeRegistrySettings, planInstall, policySources } = policy;

const KEY = `HKCU\\Software\\aify-test-${randomUUID().slice(0, 8)}`;
if (/Policies|HKLM/i.test(KEY)) throw new Error("refusing: not a scratch key");
const reg = (...args) => spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };

// The real planInstall, with the per-user source read from the scratch key and no admin source present.
const userSource = policySources("win32", process.env).find((s) => !s.admin);
const readScratch = (adminText = null) => (source) => (source.admin ? adminText : readRegistrySettings(KEY));
const install = (adminText = null) => {
  const plan = planInstall("win32", readScratch(adminText));
  if (plan.action !== "write") return plan;
  if (plan.source.key !== userSource.key) throw new Error("plan chose a source other than the per-user one");
  const wrote = writeRegistrySettings(KEY, plan.text);
  return { ...plan, wrote };
};
const ours = (p) => (p.allowedChannelPlugins || []).some((e) => e.marketplace === "aify-local" && e.plugin === "aify-channel");

console.log(`scratch key ${KEY}`);
try {
  // 1. absent value: written, read back, admits the channel.
  check("absent-before", readRegistrySettings(KEY) === null);
  const first = install();
  const afterFirst = JSON.parse(readRegistrySettings(KEY));
  check("absent-written", first.action === "write" && first.wrote.ok && afterFirst.channelsEnabled === true && ours(afterFirst), JSON.stringify(afterFirst));

  // 2. idempotent rerun: nothing to write.
  check("idempotent", install().action === "none");

  // 3. foreign keys and foreign allowlist entries kept; unicode and quotes round-trip.
  const foreign = { model: "x", "naïve ключ": "quote \" and 'single' and \\ back", allowedChannelPlugins: [{ marketplace: "other", plugin: "theirs" }], channelsEnabled: false };
  writeRegistrySettings(KEY, JSON.stringify(foreign));
  const roundTrip = readRegistrySettings(KEY);
  check("unicode-round-trip", roundTrip === JSON.stringify(foreign), JSON.stringify(roundTrip));
  const merged = install();
  const afterMerge = (() => { try { return JSON.parse(readRegistrySettings(KEY)); } catch { return null; } })();
  check("foreign-kept", merged.action === "write" && afterMerge && afterMerge.model === "x"
    && afterMerge["naïve ключ"] === foreign["naïve ключ"] && afterMerge.allowedChannelPlugins.some((e) => e.plugin === "theirs")
    && ours(afterMerge) && afterMerge.channelsEnabled === true, JSON.stringify(afterMerge));

  // 4. another value under the same key survives the write.
  reg("add", KEY, "/v", "Other", "/t", "REG_SZ", "/d", "keep-me", "/f");
  writeRegistrySettings(KEY, JSON.stringify(afterMerge));
  const other = reg("query", KEY, "/v", "Other");
  check("sibling-value-kept", other.status === 0 && /keep-me/.test(other.stdout), other.status === 0 ? "" : other.stderr.trim());

  // 5. malformed value refused, left byte-identical.
  reg("add", KEY, "/v", "Settings", "/t", "REG_SZ", "/d", "{not json", "/f");
  const refused = install();
  check("malformed-refused", refused.action === "refuse" && readRegistrySettings(KEY) === "{not json", refused.reason);

  // 6. a Settings value of another type is not read as absent and overwritten.
  reg("delete", KEY, "/v", "Settings", "/f");
  reg("add", KEY, "/v", "Settings", "/t", "REG_EXPAND_SZ", "/d", JSON.stringify({ model: "expand" }), "/f");
  const typed = install();
  const typedAfter = reg("query", KEY, "/v", "Settings");
  check("other-type-not-overwritten", typed.action === "refuse" && /REG_EXPAND_SZ/.test(typedAfter.stdout), `${typed.action}: ${typed.reason ?? ""}`);

  // 7. an admin policy in charge: refused, nothing written.
  reg("delete", KEY, "/v", "Settings", "/f");
  const admin = install(JSON.stringify({ model: "admin" }));
  check("admin-refused", admin.action === "refuse" && readRegistrySettings(KEY) === null, admin.reason);

  // 8. an operator's pretty-printed policy (newlines, a line opening with "[") merges and keeps its keys.
  const pretty = "{\n  \"model\": \"y\",\n  \"permissions\": {\n    \"deny\": [\n[\"x\"]\n    ]\n  }\n}";
  writeRegistrySettings(KEY, pretty);
  const prettyRead = readRegistrySettings(KEY);
  const prettyMerged = install();
  const prettyAfter = (() => { try { return JSON.parse(readRegistrySettings(KEY)); } catch { return null; } })();
  check("pretty-printed-merged", prettyRead === pretty && prettyMerged.action === "write" && prettyAfter?.model === "y"
    && JSON.stringify(prettyAfter.permissions) === JSON.stringify(JSON.parse(pretty).permissions) && ours(prettyAfter), JSON.stringify(prettyAfter));

  // 9. the real admin key, read only: absent on this host is null, not unreadable.
  const hklm = policySources("win32", process.env)[0].key;
  check("real-hklm-read-absent", readRegistrySettings(hklm) === null, hklm);

  // 10. no export file left behind.
  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`aify-channel-policy-${process.pid}-`));
  check("no-temp-file-left", leftovers.length === 0, leftovers.join(","));
} finally {
  const before = reg("query", KEY);
  removeRegistrySettings(KEY);
  reg("delete", KEY, "/f");
  const after = reg("query", KEY);
  check("cleanup", before.status === 0 && after.status !== 0, `present-before=${before.status === 0} absent-after=${after.status !== 0}`);
}
process.exit(results.every(Boolean) ? 0 : 1);
