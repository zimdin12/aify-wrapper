// This host's machine id: `<tag>:<host>`, lower-cased, as aify-env's `machineIdFor` (lib/advertise.mjs) and its
// `hostIsWsl` (lib/host-wsl.mjs) derive it. aify-comms' bridge and aify-dashboard's bridge use the same rule, and a
// service places an agent in a project by it, so a spelling that differs places nobody, silently: dashboard-manager
// showed `win32:StevenZ-L` answered with no project on 2026-10-18.
//
// A COPY OF THE RULE, held to aify-env's by tests/machine-id-is-aify-envs.test.js, which drives both over the same
// inputs. Pure, with the filesystem read injected.

import { readFileSync } from "node:fs";

/** PURE. The machine id for these host facts. */
export function machineIdFor({ platform = "", hostname = "", env = {}, isWsl = false } = {}) {
  const host = String(
    env.AIFY_MACHINE_ID || env.COMPUTERNAME || env.HOSTNAME || hostname || "",
  ).trim() || "unknown-host";
  const tag = platform === "linux" && isWsl ? "wsl" : String(platform || "");
  return `${tag}:${host}`.toLowerCase();
}

/** Whether this host is WSL, read from /proc and never from an environment variable. Unreadable is not WSL. */
export function hostIsWsl({ platform = process.platform, readFile = readFileSync } = {}) {
  if (platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(readFile("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}
