// Installs aify's channel plugin so claude-aify can start without the development-channels prompt.
//
//   node lib/channel-install.mjs install --bridge-dir <dir>   bridge checked, policy merged, plugin rendered and installed
//   node lib/channel-install.mjs check [--bridge-dir <dir>]   the route claude-aify would take here, and why
//   node lib/channel-install.mjs remove                       plugin and marketplace removed, our policy entry taken out
//
// NOTHING ELSE IS TOUCHED. The user-scope aify-comms-channel server stays: it is the development route, and every
// server decides for itself whether it produces (lib/channel-route.mjs), so it never needs removing. This is the
// only code that writes the per-user policy, and it runs at the operator's go-live, never from a launcher. A step that
// fails stops the install, with no rollback: the plugin is uninstalled and added again, so a failure after the
// uninstall leaves it uninstalled, and the launcher then declines the plugin route until `install` runs again. Exit 0
// done, 78 refused or incomplete (with the reason), 64 bad usage.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule } from "./main-module.mjs";
import { effectivePolicy, OUR_ENTRY, planInstall, policySources, readSource, removeRegistrySettings,
  withoutOurChannel, writeRegistrySettings } from "./channel-policy.mjs";
import { marketplaceDir, renderMarketplace } from "./channel-plugin.mjs";
import { gateOf, PLUGIN_ENTRY, PLUGIN_ID, routeHere, SUPPORTED_GATE, USER_SCOPE_ENTRY } from "./channel-route.mjs";

/** Run `claude <args>`; ok when it exits 0. */
const claudeCli = (args) => {
  const result = spawnSync("claude", args, { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
  return { ok: result.status === 0, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
};

/** Write the rendered marketplace under `dir`. */
const writeTree = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
};

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

/**
 * Install, step by step. Every collaborator is injected so the order and every refusal are tested without the real
 * registry, the real Claude configuration or the real claude.
 */
export function installChannel({ bridgeDir, platform = process.platform, home = os.homedir(), read = readSource,
  write = writeRegistrySettings, readScript = readText, writeFiles = writeTree, claude = claudeCli,
  route = () => routeHere({ platform, home, bridgeDir }) } = {}) {
  const steps = [];
  if (!bridgeDir) return { ok: false, steps, reason: "--bridge-dir is required: the aify-comms bridge the plugin runs" };
  const entry = path.join(bridgeDir, PLUGIN_ENTRY);
  if (readScript(entry) === null) return { ok: false, steps, reason: `${entry} is missing; update aify-comms first` };
  if (gateOf(entry, readScript) !== SUPPORTED_GATE) {
    return { ok: false, steps, reason: `${path.join(bridgeDir, USER_SCOPE_ENTRY)} does not declare producer gate ${SUPPORTED_GATE}; update aify-comms first` };
  }
  const plan = planInstall(platform, read);
  if (plan.action === "refuse") return { ok: false, steps, reason: plan.reason };
  if (plan.action === "write") {
    const wrote = write(plan.source.key, plan.text);
    if (!wrote.ok) return { ok: false, steps, reason: `the policy was not written: ${wrote.reason}` };
    steps.push(`policy written to ${plan.source.key}`);
  } else {
    steps.push(plan.reason);
  }
  if (planInstall(platform, read).action !== "none") return { ok: false, steps, reason: "the policy read back does not admit the channel" };

  const dir = marketplaceDir(home);
  writeFiles(dir, renderMarketplace(bridgeDir));
  steps.push(`plugin rendered at ${dir} for ${bridgeDir}`);
  // Claude installs a copy of the plugin, so a re-render reaches it only through a fresh install.
  claude(["plugin", "uninstall", PLUGIN_ID]);
  claude(["plugin", "marketplace", "remove", OUR_ENTRY.marketplace]);
  for (const args of [["plugin", "marketplace", "add", dir], ["plugin", "install", PLUGIN_ID]]) {
    const ran = claude(args);
    if (!ran.ok) return { ok: false, steps, reason: `claude ${args.join(" ")} failed: ${ran.out}` };
    steps.push(`claude ${args.slice(0, 3).join(" ")} done`);
  }
  const decision = route();
  if (decision.route !== "plugin") return { ok: false, steps, reason: `installed, but the route here is ${decision.route}: ${decision.reason}` };
  steps.push("claude-aify will start with --channels plugin:aify-channel@aify-local");
  return { ok: true, steps };
}

/** Remove the plugin, its marketplace, and our policy entry (the whole value only when nothing else is in it). */
export function removeChannel({ platform = process.platform, read = readSource, write = writeRegistrySettings,
  remove = removeRegistrySettings, claude = claudeCli } = {}) {
  const steps = [];
  const uninstalled = claude(["plugin", "uninstall", PLUGIN_ID]);
  steps.push(uninstalled.ok ? "plugin uninstalled" : "the plugin was not installed");
  const removed = claude(["plugin", "marketplace", "remove", OUR_ENTRY.marketplace]);
  steps.push(removed.ok ? "marketplace removed" : "the marketplace was not added");
  const user = policySources(platform).find((s) => !s.admin);
  if (user) {
    const next = withoutOurChannel(read(user));
    if (!next.ok) return { ok: false, steps, reason: `the per-user policy was left as it is: ${next.reason}` };
    if (next.changed) {
      const done = next.remove ? remove(user.key) : write(user.key, next.text);
      if (!done.ok) return { ok: false, steps, reason: done.reason };
      steps.push(next.remove ? `${user.key} Settings removed` : `our entry removed from ${user.key}`);
    }
  }
  return { ok: true, steps };
}

/** `--bridge-dir <dir>` out of argv, or undefined. */
export function bridgeDirArg(argv) {
  const at = argv.indexOf("--bridge-dir");
  return at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith("--bridge-dir="))?.slice("--bridge-dir=".length);
}

if (isMainModule(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const bridgeDir = bridgeDirArg(rest);
  if (command === "check") {
    const decision = routeHere({ bridgeDir });
    const policy = effectivePolicy(process.platform, (source) => readSource(source));
    process.stdout.write(`route: ${decision.route}${decision.reason ? ` (${decision.reason})` : ""}\n`
      + `policy source: ${policy.source ? (policy.source.key ?? policy.source.path) : "none"}\n`);
    process.exit(0);
  }
  const run = command === "install" ? () => installChannel({ bridgeDir }) : command === "remove" ? () => removeChannel() : null;
  if (!run) {
    process.stderr.write("usage: channel-install.mjs install --bridge-dir <dir> | check [--bridge-dir <dir>] | remove\n");
    process.exit(64);
  }
  const result = run();
  for (const step of result.steps) process.stdout.write(`${step}\n`);
  if (!result.ok) process.stderr.write(`channel ${command}: ${result.reason}\n`);
  process.exit(result.ok ? 0 : 78);
}
