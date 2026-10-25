"""Record a hermes session's named-file reads and writes, as bin/aify-tool-event.mjs does for Claude Code.

WHERE. Hermes (d923a5eb487) fires post_tool_call after every tool with tool_name, args, task_id, session_id,
tool_call_id and status (model_tools.py). Hermes runs hooks only for plugins listed in `plugins.enabled`, so this rides
on the aify-comms plugin hermes-aify already enables: hermes-aify names this file in AIFY_FILE_ACTIVITY_HERMES_PLUGIN
only when AIFY_FILE_ACTIVITY=1, and that plugin's loader hands it the PluginContext.

WHAT. Only read_file, write_file and patch, and only the file their own `path` argument names: never a shell command,
never search_files, never a patch with no path. The path is the one hermes' own resolver gives the task
(tools/file_tools_paths.py), so a relative path means what the tool took it to mean. A task whose files live elsewhere
(ssh or a container) records nothing, and so does a call from a subagent, whose session is not the agent's.

NEVER WAITS. The callback runs on the agent's thread, and a node start costs 85-260 ms on Windows (measured
2026-10-25, p50-p95). So it starts bin/aify-hermes-file-event.mjs, writes the event to its stdin, and returns; a reaper
thread collects the exit. Every failure returns None and nothing is raised.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time

_EVENT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "aify-hermes-file-event.mjs")
_TOOLS = frozenset({"read_file", "write_file", "patch"})
_OUTCOMES = {"ok": "success", "error": "failure"}
_pending: list[subprocess.Popen] = []
_pending_lock = threading.Lock()


def _resolved(path: str, task_id: str) -> str | None:
    """Hermes' own answer for `path` in this task, or None when the task's files are not this host's."""
    try:
        from tools import file_tools_paths as paths

        if paths._terminal_env_type_for_task(task_id) == "ssh" or paths._uses_container_paths(task_id):
            return None
        return str(paths._resolve_path_for_task(path, task_id))
    except Exception:
        return None


def _reap(process: subprocess.Popen) -> None:
    try:
        process.wait(timeout=30)
    except Exception:
        process.kill()
    finally:
        with _pending_lock:
            if process in _pending:
                _pending.remove(process)


def _hand_off(payload: dict, outcome: str) -> None:
    node = shutil.which("node")
    if not node:
        return
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    process = subprocess.Popen([node, _EVENT, outcome], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, **flags)
    with _pending_lock:
        _pending.append(process)
    try:
        process.stdin.write(json.dumps(payload).encode("utf-8"))
    finally:
        process.stdin.close()
    threading.Thread(target=_reap, args=(process,), daemon=True).start()


def _drain(timeout: float) -> None:
    """Wait for every event handed off so far, for at most `timeout` seconds in all."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _pending_lock:
            if not _pending:
                return
        time.sleep(0.02)


def _observed(**kwargs):
    try:
        tool = kwargs.get("tool_name")
        args = kwargs.get("args")
        outcome = _OUTCOMES.get(kwargs.get("status"))
        if tool not in _TOOLS or not isinstance(args, dict) or outcome is None or kwargs.get("parent_session_id"):
            return None
        path = args.get("path")
        if not isinstance(path, str) or not path:
            return None
        canonical = _resolved(path, kwargs.get("task_id") or "default")
        if not canonical:
            return None
        _hand_off({"tool_name": tool, "raw": path, "canonical": canonical, "session_id": kwargs.get("session_id") or "",
                   "tool_call_id": kwargs.get("tool_call_id") or "", "observed_at": int(time.time() * 1000)}, outcome)
    except Exception:
        pass
    return None


def register(ctx) -> None:  # noqa: ANN001 - hermes PluginContext
    ctx.register_hook("post_tool_call", _observed)
