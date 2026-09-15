#!/usr/bin/env node
// The launchers' side of lib/agent-lease.mjs.
//
//   aify-agent-lease claim   --agent ID --pid PID [--runtime R] [--mode M] [--intent start|replace]
//   aify-agent-lease attach  --agent ID --pid PID --kind K [--instance PID]
//   aify-agent-lease release --agent ID --pid PID
//
// EXIT 75 MEANS REFUSED and nothing else does. A start is refused when it meets:
//   - a live instance, and its intent is `start`;
//   - the agent's own live instance, around the launcher itself (nested), whatever its intent;
//   - a process that would not stop;
//   - a recorded process still running while the process table cannot be read;
//   - another start of the same agent still holding the lock after a minute.
// Every failure of this helper itself -- a bad argument, an unwritable directory -- prints a warning and
// exits 0, because the launcher runs it on the path of an operator starting an agent: a broken lease costs
// the guarantee, never the start. A refusal names what it met.
//
// --pid IS THE LAUNCHER'S OWN PID, passed in, never this process's parent. On Windows a Git Bash launcher
// runs native node through a short-lived MSYS stub, so `process.ppid` is a different dead pid on every call
// (measured 2026-09-15: launcher 88808, ppid 130368, 58336, 19600). The launcher passes /proc/$$/winpid.
// --instance defaults to AIFY_AGENT_LEASE, which the launcher exports once it holds the lease.

import process from "node:process";

import { AgentLease, LeaseBusyError, REFUSED_EXIT_CODE, startIntent } from "../lib/agent-lease.mjs";
import { isMainModule } from "../lib/main-module.mjs";

/** Every flag this helper reads, with its placeholder. The usage line and the parser both come from here. */
const FLAGS = Object.freeze({ agent: "ID", pid: "PID", runtime: "R", mode: "M", intent: "start|replace", kind: "K", instance: "PID" });
const USAGE = `usage: aify-agent-lease claim|attach|release ${Object.entries(FLAGS).map(([flag, value]) => `--${flag} ${value}`).join(" ")}`;

export function parseLeaseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(rest[i]);
    if (!match) throw new Error(`unexpected argument ${JSON.stringify(rest[i])}`);
    if (!Object.hasOwn(FLAGS, match[1])) throw new Error(`unknown flag --${match[1]}`);
    options[match[1]] = match[2] ?? rest[++i];
  }
  if (!["claim", "attach", "release"].includes(command)) throw new Error(`unknown command ${JSON.stringify(command)}`);
  const pid = Number(options.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`--pid must be a process id, got ${JSON.stringify(options.pid)}`);
  const instance = Number(options.instance ?? env.AIFY_AGENT_LEASE);
  const inherited = Number(env.AIFY_AGENT_LEASE);
  return {
    command,
    agentId: String(options.agent ?? ""),
    pid,
    runtime: String(options.runtime ?? ""),
    mode: String(options.mode ?? ""),
    intent: startIntent({ explicit: options.intent, mode: options.mode }),
    kind: String(options.kind ?? ""),
    instance: Number.isInteger(instance) && instance > 0 ? instance : null,
    inherited: Number.isInteger(inherited) && inherited > 0 ? inherited : null,
  };
}

function describe(entry) {
  const started = entry?.startedAtMs ? new Date(entry.startedAtMs).toISOString() : "an unknown time";
  const kind = entry?.kind || entry?.runtime || "process";
  return `${kind} pid ${entry?.pid}, started ${started}`;
}

/** Run one command. Returns the exit status; writes only to `err`. */
export function runLease(argv, { env = process.env, err = process.stderr, lease = (options) => new AgentLease(options) } = {}) {
  const say = (line) => err.write(`[aify-agent-lease] ${line}\n`);
  let args;
  try {
    args = parseLeaseArgs(argv, env);
    const agent = lease({ agentId: args.agentId });
    if (args.command === "claim") {
      const result = agent.claim(args);
      if (result.decision === "nested") {
        say(`${args.agentId}: this start runs inside ${args.agentId}'s own live instance (${describe(result.live)}), so it would be a second instance of the same agent. Use another agent id.`);
        return REFUSED_EXIT_CODE;
      }
      if (result.decision === "refuse" && result.reason === "unreadable-processes") {
        say(`${args.agentId}: ${describe(result.live)} is still running and this host could not read its process table to tell whether it is the recorded one, so this start could make a second instance. Try again.`);
        return REFUSED_EXIT_CODE;
      }
      if (result.decision === "refuse" && result.reason === "could-not-stop") {
        say(`${args.agentId}: could not stop ${describe(result.live)}, so this start would make a second instance. Stop it, then start again.`);
        return REFUSED_EXIT_CODE;
      }
      if (result.decision === "refuse") {
        say(`${args.agentId} is already running (${describe(result.live)}). An automatic start does not replace it: stop it, or start the agent explicitly.`);
        return REFUSED_EXIT_CODE;
      }
      for (const entry of result.stopped) say(`${args.agentId}: stopped ${describe(entry)} before this start.`);
      return 0;
    }
    if (args.command === "attach") {
      if (!args.instance) throw new Error("attach needs --instance or AIFY_AGENT_LEASE");
      agent.attach({ instance: args.instance, pid: args.pid, kind: args.kind });
      return 0;
    }
    agent.release({ pid: args.pid });
    return 0;
  } catch (error) {
    if (error instanceof LeaseBusyError && args?.command === "claim") {
      say(`${args.agentId}: another start of this agent is still in progress, so this one would race it. ${error.message}`);
      return REFUSED_EXIT_CODE;
    }
    say(`WARN: ${error?.message || error}; continuing without the one-instance guarantee. ${args ? "" : USAGE}`.trim());
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runLease(process.argv.slice(2));
}
