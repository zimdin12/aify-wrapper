// Installs aify's channel plugin so claude-aify can start without the development-channels prompt.
//
//   node lib/channel-install.mjs install    policy merge, plugin install, then the legacy server removed
//   node lib/channel-install.mjs check      the route claude-aify would take, and why
//   node lib/channel-install.mjs remove     our policy entry and the plugin removed
//
// THE ORDER IS THE SAFETY. The user-scope `aify-comms-channel` server is what the development route loads,
// so it is removed only after the policy admits the plugin AND the plugin is installed, read back each
// time. A step that fails stops the install with the development route intact. Exit 0 done, 78 refused or
// incomplete (with the reason), 64 bad usage.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./main-module.mjs";
import { CHANNEL_SPEC, effectivePolicy, planInstall, policySources, readSource, removeRegistrySettings,
  withoutOurChannel, writeRegistrySettings } from "./channel-policy.mjs";
import { LEGACY_SERVER, PLUGIN_ID, routeHere } from "./channel-route.mjs";

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MARKETPLACE_DIR = path.join(PACKAGE_ROOT, "plugins", "aify-local");

/** Run `claude <args>`; ok when it exits 0. */
const claudeCli = (args) => {
  const result = spawnSync("claude", args, { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
  return { ok: result.status === 0, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
};

/**
 * Install, step by step. Every collaborator is injected so the order and every refusal are tested without
 * the real registry or the real Claude configuration.
 */
export function installChannel({ platform = process.platform, read = readSource, write = writeRegistrySettings,
  claude = claudeCli, route = () => routeHere({ platform }) } = {}) {
  const steps = [];
  const plan = planInstall(platform, read);
  if (plan.action === "refuse") return { ok: false, steps, reason: plan.reason };
  if (plan.action === "write") {
    const wrote = write(plan.source.key, plan.text);
    if (!wrote.ok) return { ok: false, steps, reason: `the policy was not written: ${wrote.reason}` };
    steps.push(`policy written to ${plan.source.key}`);
  } else {
    steps.push(plan.reason);
  }
  const again = planInstall(platform, read);
  if (again.action !== "none") return { ok: false, steps, reason: "the policy read back does not admit the channel" };

  for (const args of [["plugin", "marketplace", "add", MARKETPLACE_DIR], ["plugin", "install", PLUGIN_ID]]) {
    const ran = claude(args);
    if (!ran.ok) return { ok: false, steps, reason: `claude ${args.join(" ")} failed: ${ran.out}` };
    steps.push(`claude ${args.slice(0, 2).join(" ")} done`);
  }
  // Only now: the plugin is admitted and installed, so the development route's server can go.
  const removed = claude(["mcp", "remove", "--scope", "user", LEGACY_SERVER]);
  steps.push(removed.ok ? `user-scope ${LEGACY_SERVER} removed` : `no user-scope ${LEGACY_SERVER} to remove`);
  const decision = route();
  if (decision.route !== "plugin") return { ok: false, steps, reason: `installed, but the route is still dev: ${decision.reason}` };
  steps.push(`claude-aify will start with --channels ${CHANNEL_SPEC}`);
  return { ok: true, steps };
}

/** Remove our policy entry (the whole value only when nothing else is in it) and the plugin. */
export function removeChannel({ platform = process.platform, read = readSource, write = writeRegistrySettings,
  remove = removeRegistrySettings, claude = claudeCli } = {}) {
  const steps = [];
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
  const ran = claude(["plugin", "uninstall", PLUGIN_ID]);
  steps.push(ran.ok ? "plugin uninstalled" : "the plugin was not installed");
  steps.push("re-run aify-comms' installer to restore the development channel's server");
  return { ok: true, steps };
}

if (isMainModule(import.meta.url)) {
  const command = process.argv[2];
  if (command === "check") {
    const decision = routeHere();
    const policy = effectivePolicy(process.platform, (source) => readSource(source));
    process.stdout.write(`route: ${decision.route}${decision.reason ? ` (${decision.reason})` : ""}\n`
      + `policy source: ${policy.source ? (policy.source.key ?? policy.source.path) : "none"}\n`);
    process.exit(0);
  }
  const run = command === "install" ? installChannel : command === "remove" ? removeChannel : null;
  if (!run) {
    process.stderr.write("usage: channel-install.mjs install|check|remove\n");
    process.exit(64);
  }
  const result = run();
  for (const step of result.steps) process.stdout.write(`${step}\n`);
  if (!result.ok) process.stderr.write(`channel ${command}: ${result.reason}\n`);
  process.exit(result.ok ? 0 : 78);
}
