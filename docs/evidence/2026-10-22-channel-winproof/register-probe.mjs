// Does `claude --channels plugin:aify-channel@<marketplace>` register on this host's real login, with NO policy
// written? The plugin is loaded for the session only (--plugin-dir); no MCP server but the plugin's own
// (--strict-mcp-config, an empty --mcp-config); no prompt is sent. The child environment is scrubbed of every AIFY_*,
// HERDR_* and CLAUDE* variable, so a nested claude cannot take over this agent's identity or lease.
//
// Usage: node register-probe.mjs <label> <out-dir> <cwd> -- <claude flags...>
// Writes <out-dir>/<label>.screen.txt (ANSI stripped, at most 64 KB) and <label>.raw.txt (at most 256 KB), and
// <label>.server.log from the plugin's server (at most 200 lines). Exits it after CAPTURE_MS.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const pty = require("C:/Users/Administrator/projects/aify-env/node_modules/node-pty");

const [label, outDir, cwd, sep, ...flags] = process.argv.slice(2);
if (!label || !outDir || !cwd || sep !== "--") throw new Error("usage: node register-probe.mjs <label> <out-dir> <cwd> -- <flags>");
const CAPTURE_MS = Number(process.env.PROBE_CAPTURE_MS || 20000);
const RAW_CAP = 256 * 1024;
const SCREEN_CAP = 64 * 1024;

// The session-only plugin: declares the channel capability and never pushes, so nothing starts a model turn.
const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-register-probe-"));
const plugin = path.join(pluginRoot, "aify-channel");
const serverLog = path.join(outDir, `${label}.server.log`);
fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({
  name: "aify-channel", version: "0.0.1", description: "register probe: declares the channel capability, pushes nothing",
  mcpServers: { "aify-comms-channel": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/channel.mjs"] } },
}, null, 2));
fs.writeFileSync(path.join(plugin, "channel.mjs"), `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const LOG = ${JSON.stringify(serverLog)};
let lines = 0;
const log = (l) => { if (lines++ < 200) appendFileSync(LOG, new Date().toISOString() + " " + l + "\\n"); };
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
log("started pid " + process.pid);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log("in " + (m.method ?? "response"));
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18",
    capabilities: { experimental: { "claude/channel": {} }, tools: {} }, serverInfo: { name: "aify-comms-channel", version: "0.0.1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
`);
const emptyMcp = path.join(pluginRoot, "empty-mcp.json");
fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AIFY_|HERDR_|CLAUDE)/i.test(k)));
const args = ["--strict-mcp-config", "--mcp-config", emptyMcp, "--plugin-dir", plugin, ...flags];
fs.writeFileSync(path.join(outDir, `${label}.cmd.txt`), `cwd ${cwd}\nclaude ${args.map((a) => (a.startsWith(os.tmpdir()) ? `<tmp>${a.slice(os.tmpdir().length)}` : a)).join(" ")}\nscrubbed ${Object.keys(process.env).filter((k) => !(k in env)).sort().join(" ")}\n`);

let raw = "";
const child = pty.spawn("C:\\Users\\Administrator\\.local\\bin\\claude.exe", args, { name: "xterm-256color", cols: 160, rows: 48, cwd, env });
child.onData((d) => { if (raw.length < RAW_CAP) raw += d.slice(0, RAW_CAP - raw.length); });
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b[@-_]/g, "");
const pid = child.pid;
let exited = false;
child.onExit(() => { exited = true; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(CAPTURE_MS);
const screenAtCapture = strip(raw);
if (/Exit/i.test(screenAtCapture) && /development channels/i.test(screenAtCapture)) {
  // The development-channels dialog: pick its Exit choice by its number if shown, else leave it to the kill below.
  const numbered = /(\d)\.\s*Exit/i.exec(screenAtCapture);
  if (numbered) child.write(numbered[1]);
} else {
  child.write("/exit\r");
}
await wait(5000);
if (!exited) { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
await wait(1000);
fs.writeFileSync(path.join(outDir, `${label}.raw.txt`), raw);
fs.writeFileSync(path.join(outDir, `${label}.screen.txt`), strip(raw).slice(0, SCREEN_CAP));
const survivors = execFileSync("powershell", ["-NoProfile", "-Command",
  `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*${path.basename(pluginRoot)}*' -or $_.ProcessId -eq ${pid}) } | ForEach-Object { \"$($_.ProcessId):$($_.Name)\" }`], { encoding: "utf8" }).trim();
fs.rmSync(pluginRoot, { recursive: true, force: true });
console.log(`${label}: pid ${pid} exited-by-itself=${exited} survivors=[${survivors.replace(/\s+/g, ",")}]`);
