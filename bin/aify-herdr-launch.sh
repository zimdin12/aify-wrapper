# Herdr, at the start of every launcher: the host's profile given back to the agent, this pane claimed so a restore
# brings back this wrapper rather than a bare agent, and whether the agent's own hooks report its state. Sourced by
# claude-, codex-, hermes- and pi-aify, which set AIFY_WRAPPER_DIR_FWD and AIFY_HERDR_ARGV first (the invocation,
# verbatim: `"$0" "$@"` is only the launcher's in its own scope); `${0##*/}` names the launcher. NO FUNCTION HERE CAN
# FAIL THE LAUNCH: the first two return 0 whatever happens, and the third is only ever asked in an `if`.

# ── Herdr: whether this agent's own hooks report its state to a pane ───
#
# They do for a pane this launcher claimed, and for the pane aify-env names for a managed worker in
# AIFY_HERDR_PANE_FILE, which is where the state script reports when that file is set. They do NOT when aify-env's
# pane reporter speaks for that pane: AIFY_HERDR_PANE_REPORTER=herdr:aify, which aify-env (0.9.10 on) sets beside the
# pane file only where its reporter tells the pane its word for the agent (Herdr status sync phase 1). Two writers on
# one pane disagree; the reporter's word is the one the dashboard shows, and its pane closes with the worker, so no
# exit report is owed either. The pane file ALONE is every aify-env before the reporter, and keeps the hooks: gating
# on it would leave those panes with no writer at all.
aify_herdr_hooks_report() {
  if [ -n "${AIFY_HERDR_PANE_FILE:-}" ] && [ "${AIFY_HERDR_PANE_REPORTER:-}" = "herdr:aify" ]; then return 1; fi
  [ "${AIFY_HERDR_CLAIM:-}" = "claimed" ] || [ -n "${AIFY_HERDR_PANE_FILE:-}" ]
}

# ── Herdr: give this agent back the profile the HOST had ───
#
# `herdr-aify` runs an isolated Herdr whose XDG roots point inside one invocation's directory, and
# everything started in a pane inherits them. That isolation is Herdr's, not the agent's: an agent
# that kept it would write its profile and logs into a directory that is deleted when the invocation
# ends. The launcher records what the host had, and this puts it back.
#
# `${VAR+set}` DISTINGUISHES SET-BUT-EMPTY FROM NEVER-SET, so a host with no XDG_CONFIG_HOME leaves
# the agent without one instead of being handed an empty string.
#
# An ordinary launch never enters this: nothing sets AIFY_HERDR_ISOLATED outside a dedicated instance.
aify_herdr_restore_profile() {
  if [ "${AIFY_HERDR_ISOLATED:-}" = "1" ]; then
    if [ -n "${AIFY_HERDR_HOST_XDG_CONFIG_HOME+set}" ]; then
      export XDG_CONFIG_HOME="$AIFY_HERDR_HOST_XDG_CONFIG_HOME"
    else
      unset XDG_CONFIG_HOME
    fi
    if [ -n "${AIFY_HERDR_HOST_XDG_STATE_HOME+set}" ]; then
      export XDG_STATE_HOME="$AIFY_HERDR_HOST_XDG_STATE_HOME"
    else
      unset XDG_STATE_HOME
    fi
  fi
  return 0
}

# ── Herdr: claim this pane so it comes back as this wrapper, not as a bare agent ───
#
# WHAT IT BUYS. Start this wrapper in a Herdr pane, restart the machine, and the pane comes back
# running this wrapper again instead of the bare CLI underneath it.
#
# HOW, measured against Herdr 0.9.0 rather than assumed: the claim labels the pane and reports the
# agent under the source `herdr:aify`, which is NOT one of the (source, agent) pairs Herdr's own
# allowlist contains. Herdr therefore persists no agent session for this pane, and on restore leaves
# it an empty shell carrying its label -- which the aify plugin's startup hook matches against its
# ledger and fills with this exact command. Panes running a bare `claude` or `hermes` are untouched
# and keep Herdr's native resume, which is the half of the contract that must not regress.
#
# GATED ON HERDR_ENV so an ordinary terminal launch pays nothing: that variable is set only inside a
# pane, and without it this block never starts node at all. `--pane-file`, for a launcher whose managed
# worker aify-env names a pane for in AIFY_HERDR_PANE_FILE (codex, whose hooks are built from these paths):
# that resolves the paths too, but claims nothing. Hermes reads the pane file itself and needs neither.
#
# IT CAN NEVER FAIL THE LAUNCH. This runs on the path of the operator starting an agent, so a Herdr
# that is busy, mid-handoff or gone costs the pane its label and never costs the agent its start.
aify_herdr_claim_pane() {
  local _pane_file=false
  [ "${1:-}" = --pane-file ] && _pane_file=true
  if [ "${HERDR_ENV:-}" = "1" ] || { [ "$_pane_file" = true ] && [ -n "${AIFY_HERDR_PANE_FILE:-}" ]; }; then
    # From the wrapper's own install root, converted for node once at the top of the launcher.
    AIFY_HERDR_HELPER="$AIFY_WRAPPER_DIR_FWD/bin/aify-herdr-pane.mjs"
    # STDERR GOES TO A LOG, NOT TO NOWHERE. It used to go to /dev/null, which made every failure of
    # this feature -- a lost record, a pane labelled but never reported, a refused relaunch -- invisible
    # until a reboot did not bring an agent back, with nothing anywhere saying why. It stays off the
    # agent's terminal, because this must not print into the operator's session.
    # The log directory may not exist on a host where no wrapper has ever claimed a pane, and a
    # redirect into a missing directory fails IN THE SHELL before node runs -- printing its own
    # error into the operator's terminal. So it is created first, and the log falls back to nowhere
    # if it cannot be. Both lines return 0 whatever happens.
    AIFY_HERDR_LOG="${HOME:-.}/.aify/herdr/claim.log"
    mkdir -p "${HOME:-.}/.aify/herdr" 2>/dev/null || AIFY_HERDR_LOG=/dev/null
    # The claim prints `claimed` only when the pane is ours, which is what lets the agent's hooks report
    # its state. `|| AIFY_HERDR_CLAIM=""` keeps a failed claim from aborting under `set -e`.
    if [ "${HERDR_ENV:-}" = "1" ]; then
      AIFY_HERDR_CLAIM="$(node "$AIFY_HERDR_HELPER" claim --wrapper "${0##*/}" -- "${AIFY_HERDR_ARGV[@]}" 2>>"$AIFY_HERDR_LOG")" || AIFY_HERDR_CLAIM=""
      # HERDR'S OWN AGENT INTEGRATION MUST NOT SPEAK FOR A PANE THIS CLAIM OWNS. Herdr installs a
      # SessionStart hook into the agent's own configuration -- `HERDR_INTEGRATION_ID=<the runtime>` -- and
      # that hook runs INSIDE the agent this launcher starts. It sends `pane.report_agent_session` under
      # Herdr's own source with the agent's session id, which OVERWRITES the `herdr:aify` report the claim
      # just made. Herdr then persists a resumable session for the pane after all and, at the next start,
      # natively types a BARE agent command into it: no wrapper, no lease, no bridge, and the aify restore
      # refuses the pane because Herdr reported an agent on it. Measured 2026-09-16 against Herdr 0.9.0.
      #
      # THE HOOK GATES ON HERDR_PANE_ID, so taking that one variable out of the agent's environment is what
      # stops it, and it stops nothing else. aify's own state hooks read the pane from AIFY_HERDR_PANE_ID
      # instead, and a pane this launcher did NOT claim keeps its variable, its integration and Herdr's
      # native resume exactly as before -- which is the half of the contract that must not regress.
      if [ "${AIFY_HERDR_CLAIM:-}" = "claimed" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
        export AIFY_HERDR_PANE_ID="$HERDR_PANE_ID"
        unset HERDR_PANE_ID
      fi
    fi
  fi
  return 0
}
