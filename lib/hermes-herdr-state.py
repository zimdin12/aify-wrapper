"""Report what a hermes agent in an aify pane is doing to Herdr, so the pane's status dot follows it.

WHY. A claimed pane shows the state its `herdr:aify` claim last reported and ignores Herdr's screen
detection (Herdr 0.9.0 `recompute_effective_state`). The claim said `idle` once, so the dot read idle
for the life of the pane. hermes-aify exports AIFY_HERDR_HERMES_PLUGIN pointing here when the pane is
claimed or aify-env names one, and the aify-comms hermes plugin passes its PluginContext to
`register`.

WHICH HOOKS, chosen from where hermes (v0.21.2) fires them, not from their names:

  pre_llm_call            agent/turn_context.py build_turn_context: once per turn, before the model
                          is called. Despite the name it is not per API call.       -> working
  pre_approval_request    tools/approval*.py, immediately before a person is asked.  -> blocked
  post_approval_response  the same sites, after the answer; the turn carries on.     -> working
  on_session_end          agent/turn_finalizer.py finalize_turn: at the end of EVERY turn, completed,
                          failed or interrupted (run_conversation runs once per message), and when
                          tui_gateway closes a session.                               -> idle

Not used: post_llm_call fires inside finalize_turn only when there is a response, so it is a subset
of on_session_end; agent_loop_stopped fires when a stop is REQUESTED, before the loop has ended, and
the interrupted turn still reaches on_session_end. A turn ended by a non-retryable API error returns
from the loop without finalize_turn, fires none of these, and leaves the dot at working until the
next turn.

Subagents (tools/delegate_tool.py) run the same turn code with platform="subagent"; they are ignored
so a child finishing does not make its parent read idle. An approval decided by the auxiliary model
(surface "smart") waits on nobody and is ignored too.

The report itself is bin/aify-herdr-state.sh, the one implementation of which pane and which source.
Every callback returns None and never raises: hooks run on the agent's own thread.
"""

from __future__ import annotations

import os
import subprocess

_STATE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "aify-herdr-state.sh")


def _report(state: str) -> None:
    if not os.environ.get("AIFY_HERDR_AGENT"):
        return
    try:
        kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "timeout": 3}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        subprocess.run(["sh", _STATE_SCRIPT, state], check=False, **kwargs)
    except Exception:
        pass


def _turn_started(**kwargs) -> None:
    if kwargs.get("platform") != "subagent":
        _report("working")


def _turn_ended(**kwargs) -> None:
    if kwargs.get("platform") != "subagent":
        _report("idle")


def _approval_asked(**kwargs) -> None:
    if kwargs.get("surface") != "smart":
        _report("blocked")


def _approval_answered(**kwargs) -> None:
    if kwargs.get("surface") != "smart":
        _report("working")


def register(ctx) -> None:  # noqa: ANN001 - hermes PluginContext
    ctx.register_hook("pre_llm_call", _turn_started)
    ctx.register_hook("pre_approval_request", _approval_asked)
    ctx.register_hook("post_approval_response", _approval_answered)
    ctx.register_hook("on_session_end", _turn_ended)
