// The aify-channel plugin's server: it runs aify-comms' installed channel, and nothing else.
//
// THE CHANNEL'S LOGIC STAYS IN AIFY-COMMS. `claude-channel.js` is that service's code (it imports its
// bridge's modules), installed by comms' own installer into the bridge directory. This plugin is the
// wrapper's packaging of it: a plugin is what Claude Code admits as a channel without the
// development-channels prompt, once managed settings allow it (`lib/channel-policy.mjs`).
//
// Its server is named `aify-comms-channel`, as the channel always was, so events keep arriving as
// <channel source="aify-comms-channel">.
//
// WHERE THE CHANNEL IS: `AIFY_BRIDGE_DIR`, which claude-aify exports on the plugin route, else comms'
// default bridge directory. The endpoint comes the same way: the launcher's, else comms' registry entry.
// A channel that cannot be found exits non-zero with the reason; the session then has no channel, as it
// has today when the bridge is missing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { channelLaunch } from "./channel-launch.mjs";

const home = os.homedir();
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const plan = channelLaunch({ env: process.env, home, exists: (file) => fs.existsSync(file),
  registryText: readText(path.join(home, ".aify", "services.json")) });
if (!plan.ok) {
  process.stderr.write(`aify-channel: ${plan.reason}\n`);
  process.exit(78);
}
const child = spawn(process.execPath, [plan.script], { stdio: "inherit", env: plan.env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  try { process.on(signal, () => child.kill(signal)); } catch { /* not every signal exists everywhere */ }
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
