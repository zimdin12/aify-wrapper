"""Add what the registry's turn-start services say to a hermes turn, as bin/aify-turn-start.mjs does for Claude Code.

WHERE. Hermes (d923a5eb487) fires pre_llm_call once per turn, before the model is called, channel turns included, and
adds what a callback returns, {"context": text} or a str, to that turn's user message, never the system prompt
(agent/turn_context.py _collect_pre_llm_call_context). Hermes runs hooks only for plugins listed in `plugins.enabled`,
so this rides on the aify-comms plugin hermes-aify already enables: hermes-aify names this file in
AIFY_TURN_START_HERMES_PLUGIN, and that plugin's loader hands it the PluginContext.

WHAT. It runs the one implementation, bin/aify-turn-start.mjs, with the turn's session id and folder on stdin as Claude
Code's hook sends them, and hands back the additionalContext the runner prints. The runner reads the registry, asks
every turnStart service under one 1.5 s deadline, refuses a text carrying a presented key, and gates on AIFY_AGENT_ID.

THE FOLDER is hermes' own answer for the session (agent.runtime_cwd.resolve_agent_cwd: the session's workspace, then
TERMINAL_CWD, then the launch folder), because the dashboard places an agent by it. Outside hermes none is sent, and
the runner names its own, which is the launch folder it inherits.

BOUNDED. The callback runs on the agent's own thread before the model is called, so a slow answer delays the turn.
The runner closes at its own due time and exits; _GUARD_S only stops a runner that never exits, and is the 5 s Claude
Code is given for the same command. A subagent's turn asks nothing: its parent's turn already carried the rules.
Every failure returns None and nothing is raised.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "aify-turn-start.mjs")
_GUARD_S = 5
_NODE = None  # node on PATH, looked up at each turn when unset


def _folder() -> str:
    try:
        from agent.runtime_cwd import resolve_agent_cwd

        return str(resolve_agent_cwd())
    except Exception:
        return ""


def _context(**kwargs):
    if kwargs.get("platform") == "subagent":
        return None
    try:
        request = json.dumps({"session_id": kwargs.get("session_id"), "cwd": _folder(), "hook_event_name": "pre_llm_call"})
        run = {"input": request, "capture_output": True, "text": True, "encoding": "utf-8", "timeout": _GUARD_S}
        if os.name == "nt":
            run["creationflags"] = subprocess.CREATE_NO_WINDOW
        printed = subprocess.run([_NODE or shutil.which("node"), _RUNNER], check=False, **run).stdout
        return {"context": json.loads(printed)["hookSpecificOutput"]["additionalContext"]}
    except Exception:
        return None


def register(ctx) -> None:  # noqa: ANN001 - hermes PluginContext
    ctx.register_hook("pre_llm_call", _context)
