// Who a wrapper is, as far as an ordinary Herdr is concerned: which pane it runs in, what it calls
// itself there, and under whose authority it reports.
//
// MEASURED, NOT ASSUMED (2026-09-12, Herdr 0.9.0, isolated profile, Windows). A pane's shell really
// does receive `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`,
// `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH`, so a wrapper can identify its own pane without asking
// anyone. An earlier reading of this said the opposite; it had been taken inside WSL, which passes
// through only what `WSLENV` names, so the variables were real and the instrument was not.
//
// THE SOURCE IS THE WHOLE INTEGRATION. Herdr decides whether a pane gets a resume plan by whether
// the agent was reported under one of its own official (source, agent) pairs. Reporting under
// `herdr:aify` is therefore not a label choice — it is the mechanism, and it was measured:
//
//   pane reported `herdr:claude` / `claude`      -> session.json keeps agent_session -> native resume
//   pane reported `herdr:aify`   / `claude-aify` -> session.json keeps NO agent_session -> plain shell
//
// Both official-source panes in that run persisted a session and the aify-source pane did not, so
// the asymmetry is the source and not the flags. What the aify pane DOES keep is its `label`, which
// is what makes the restore in `herdr-restore.mjs` possible at all.
//
// NOTHING HERE TALKS TO HERDR. Every function is pure; the caller does the IO.

/** The one spelling of our agent source. Herdr's allowlist does not contain it, and must not. */
export const AIFY_AGENT_SOURCE = "herdr:aify";

/** Labels we own start with this, so a pane somebody else named is never mistaken for ours. */
export const AIFY_LABEL_PREFIX = "aify";

const PANE_ID = /^w[0-9]+:p[0-9]+$/;
const WORKSPACE_ID = /^w[0-9]+$/;
const TAB_ID = /^w[0-9]+:t[0-9]+$/;
// A wrapper name and a record id both ride inside a colon-delimited label, so neither may contain a
// colon. Deriving the label from these and parsing it back is the round trip the tests pin.
const LABEL_FIELD = /^[A-Za-z0-9._-]+$/;

/**
 * The pane this process is running in, or `null` when it is not running in a Herdr pane at all.
 *
 * FAILS CLOSED, and the closed answer is `null` rather than a partial object. A wrapper that got a
 * half-populated context would go on to label "some" pane and record a restore entry pointing at
 * nothing; every caller here has exactly one question — am I in a pane I can address — so a missing
 * or malformed id has to answer no. `HERDR_ENV` alone is not enough: it is inherited by any child
 * of a pane, including one a wrapper spawns after clearing the ids.
 */
export function readPaneContext(env = {}) {
  if (env.HERDR_ENV !== "1") return null;
  const paneId = String(env.HERDR_PANE_ID || "");
  const workspaceId = String(env.HERDR_WORKSPACE_ID || "");
  const tabId = String(env.HERDR_TAB_ID || "");
  const bin = String(env.HERDR_BIN_PATH || "");
  if (!PANE_ID.test(paneId)) return null;
  if (!WORKSPACE_ID.test(workspaceId)) return null;
  if (tabId && !TAB_ID.test(tabId)) return null;
  if (!bin) return null;
  return Object.freeze({ paneId, workspaceId, tabId: tabId || null, bin, socketPath: env.HERDR_SOCKET_PATH || null });
}

/**
 * The durable per-pane handle: `aify:<wrapper>:<record>`.
 *
 * IT IS THE ONLY THING THAT SURVIVES. Of everything Herdr persisted for an aify-sourced pane in the
 * measured run, exactly two fields came back: `cwd` and `label`. So the label has to carry enough to
 * find the record, and the record carries the rest.
 */
export function paneLabel({ wrapper, record }) {
  if (!LABEL_FIELD.test(String(wrapper || ""))) throw new Error("herdr_pane: wrapper must be [A-Za-z0-9._-]+");
  if (!LABEL_FIELD.test(String(record || ""))) throw new Error("herdr_pane: record must be [A-Za-z0-9._-]+");
  return `${AIFY_LABEL_PREFIX}:${wrapper}:${record}`;
}

/**
 * The inverse, and the membership test in one. `null` means "not a label we own", which is the
 * answer the restore pass needs for every pane it did not create.
 */
export function parsePaneLabel(label) {
  const parts = String(label == null ? "" : label).split(":");
  if (parts.length !== 3) return null;
  const [prefix, wrapper, record] = parts;
  if (prefix !== AIFY_LABEL_PREFIX) return null;
  if (!LABEL_FIELD.test(wrapper) || !LABEL_FIELD.test(record)) return null;
  return Object.freeze({ wrapper, record });
}

/**
 * The argv that claims this pane for aify, for the caller to run with `HERDR_BIN_PATH`.
 *
 * `state` is the agent's lifecycle state in Herdr's own vocabulary; `idle` is the honest value at
 * launch, before the agent has been asked for anything.
 */
export function reportAgentArgv({ paneId, wrapper, state = "idle" }) {
  if (!PANE_ID.test(String(paneId || ""))) throw new Error("herdr_pane: pane id required");
  if (!LABEL_FIELD.test(String(wrapper || ""))) throw new Error("herdr_pane: wrapper must be [A-Za-z0-9._-]+");
  return ["pane", "report-agent", paneId, "--source", AIFY_AGENT_SOURCE, "--agent", wrapper, "--state", state];
}

/**
 * The argv that labels this pane.
 *
 * THE LABEL IS POSITIONAL. `herdr pane rename <pane> <label>` takes it as an argument, and passing
 * `--label` instead sets the label to the literal string "--label …" — which is what happened the
 * first time this was driven by hand against a live Herdr, and it persisted that way into
 * session.json.
 */
export function renamePaneArgv({ paneId, label }) {
  if (!PANE_ID.test(String(paneId || ""))) throw new Error("herdr_pane: pane id required");
  if (!parsePaneLabel(label)) throw new Error("herdr_pane: refusing to set a label this module does not own");
  return ["pane", "rename", paneId, label];
}
