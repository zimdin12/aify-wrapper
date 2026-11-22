// A local app-server and TUI pair. A synthetic user turn drives the effective command hook, not a timer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const capture = process.env.AIFY_TEST_CODEX_CAPTURE;
if (args.includes("app-server")) {
  const entries = args.filter((arg, i) => args[i - 1] === "-c" && arg.startsWith("hooks.UserPromptSubmit="));
  assert.ok(entries.length <= 1, "app-server must receive one UserPromptSubmit list");
  const handlers = [...(entries[0] ?? "").matchAll(/\{type="command",command=("(?:[^"\\]|\\.)*"),timeout=(\d+),async=(true|false)\}/g)]
    .map(([, command, timeout, background]) => ({ command: JSON.parse(command), timeout: Number(timeout), async: background === "true" }));
  const profilePath = path.join(process.env.CODEX_HOME, "hooks.json");
  const profile = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, "utf8")) : {};
  const profileHandlers = profile.hooks?.UserPromptSubmit?.flatMap(({ hooks }) => hooks) ?? [];
  fs.writeFileSync(`${capture}.argv`, JSON.stringify(args));
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let message = "";
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET" || message) throw error; // The wrapper's readiness probe connects without sending a turn.
    });
    socket.on("data", (part) => {
      message += part;
      if (!message.endsWith("\n")) return;
      const input = JSON.parse(message);
      const added = [];
      for (const context of [...profileHandlers, ...handlers].filter((handler) => !handler.async)) {
        const run = spawnSync("bash", ["-c", context.command], { input: JSON.stringify(input), encoding: "utf8" });
        if (profileHandlers.includes(context) && run.status !== 0) continue;
        assert.equal(run.status, 0, run.stderr || run.error?.message);
        if (run.stdout) added.push(JSON.parse(run.stdout));
      }
      socket.end(JSON.stringify({ handlers, added: added[0] ?? null,
        input: [input.prompt, ...added.map((item) => item.hookSpecificOutput.additionalContext)] }));
    });
  });
  server.listen(Number(new URL(option("--listen")).port), "127.0.0.1");
} else {
  fs.writeFileSync(`${capture}.tui`, JSON.stringify(args));
  const socket = net.createConnection(Number(new URL(option("--remote")).port), "127.0.0.1");
  socket.setEncoding("utf8");
  const prompt = { session_id: "thread-1", turn_id: "turn-1", cwd: process.cwd(), hook_event_name: "UserPromptSubmit", prompt: "fixture prompt" };
  if (process.env.AIFY_TEST_CODEX_SUBAGENT === "1") prompt.agent_id = "subagent-fixture";
  let answer = "";
  socket.on("connect", () => socket.write(`${JSON.stringify(prompt)}\n`));
  socket.on("data", (part) => { answer += part; });
  socket.on("end", () => fs.writeFileSync(`${capture}.turn`, answer));
}
