// The explicit, policy-only privileged operation. No Claude/plugin operations or subprocesses live here.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { planInstall, policySources, readSource } from "./channel-policy.mjs";

const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/** Printed for the operator, never executed by the product. The path is an explicit argument. */
export function policyPreparationCommand({ node, module, file }) {
  return `sudo -- ${[node, module, "prepare-policy", "--path", file].map(quote).join(" ")}`;
}

/** The canonical managed file, created once without replacing any existing policy, including a raced one. */
export class ManagedChannelPolicyFile {
  #context;

  constructor({ platform = process.platform, uid = process.geteuid?.(), env = process.env,
    read = readSource, io = fs, nonce = randomUUID } = {}) {
    this.#context = { platform, uid, env, read, io, nonce };
  }

  prepare({ path: explicitPath } = {}) {
    const { platform, uid, env, read, io, nonce } = this.#context;
    const refuse = (reason) => ({ ok: false, steps: [], reason });
    if (platform === "win32") return refuse("prepare-policy is POSIX-only; use the Windows install command");
    const source = policySources(platform, env).find((item) => item.kind === "file");
    if (!source || explicitPath !== source.path) return refuse(`prepare-policy requires the explicit managed policy path: ${source?.path ?? "unknown"}`);
    if (uid !== 0) return refuse("prepare-policy requires root; run only the printed policy command with sudo");
    const plan = planInstall(platform, read, env);
    if (plan.action === "none") return { ok: true, steps: [`managed policy already admits the channel; nothing written at ${explicitPath}`] };
    if (plan.action !== "prepare") return refuse(plan.reason ?? "the existing managed policy was left untouched");

    const parent = path.posix.dirname(explicitPath);
    const temporary = path.posix.join(parent, `.aify-channel-policy-${nonce()}.tmp`);
    let descriptor;
    let ownedTemporary = false;
    try {
      try {
        io.mkdirSync(parent, { mode: 0o755 });
        // Only a directory this call created. An existing directory's permissions are never changed.
        io.chmodSync(parent, 0o755);
      } catch (error) {
        if (error.code !== "EEXIST" || !io.statSync(parent).isDirectory()) throw error;
      }
      descriptor = io.openSync(temporary, "wx", 0o644);
      ownedTemporary = true;
      io.writeFileSync(descriptor, `${plan.text}\n`, "utf8");
      io.fchmodSync(descriptor, 0o644);
      io.closeSync(descriptor);
      descriptor = undefined;
      // link is exclusive at the destination: unlike rename, it never replaces an existing file or symlink.
      io.linkSync(temporary, explicitPath);
    } catch (error) {
      return refuse(`managed policy was not created at ${explicitPath}: ${error.message}`);
    } finally {
      if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch { /* preserve the original failure */ } }
      if (ownedTemporary) { try { io.unlinkSync(temporary); } catch { /* only this call's temporary name, never the canonical target */ } }
    }
    if (planInstall(platform, read, env).action !== "none") return refuse("managed policy read back does not admit the channel");
    return { ok: true, steps: [`managed policy created and admission read back at ${explicitPath}; rerun the installer as the non-root user`] };
  }
}
