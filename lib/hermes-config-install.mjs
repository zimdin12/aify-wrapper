// Writes the session entries session-hermes.mjs builds into the user's hermes config, through hermes' own commands.
//
// HERMES' OWN WRITER, never a YAML edit made here. `hermes config set mcp_servers.<name> '<JSON>'` parses a structured
// value and writes it through hermes' round-trip writer: the operator's comments and other servers survive, and
// `${AIFY_AGENT_ID}` is stored literally. `hermes config unset` removes one cleanly. Neither prompts. Measured on
// hermes 0.21.5 (aify-dashboard docs/evidence/hermes-session-mcp-2026-10-02, config-set-writer.txt). `hermes mcp add`
// and `mcp remove` prompt, and `add` test-starts the server.
//
// ONLY OUR OWN ENTRIES. An entry is ours when it carries `x-aify-owner: aify-wrapper`. A same-named entry without it
// is the operator's, and the install refuses rather than replacing it. A save while another layer defines the same
// name deletes the operator's values, so a same-name replace is the data loss this exists to avoid.
//
// Every call is bounded, and every refusal names its step. The runner is injected: `run(args)` returns
// `{status, stdout, stderr}`, with a null status for a call that timed out or could not start.

import { OWNER, OWNER_KEY } from "./session-hermes.mjs";

/**
 * Why HERMES_HOME cannot be read as written, or null.
 *
 * Hermes expands `~`, `$VAR`, `${VAR}` and `%VAR%` in HERMES_HOME (hermes_constants.py `_expand_hermes_home`, 0.21.5),
 * and the roots below read the text as written. Such a home is refused rather than expanded here, because a second
 * expander would be a second parser of hermes' rule, and a wrong one sends the update check to a directory hermes
 * never uses.
 */
export function unexpandedHomeProblem(env) {
  const home = env.HERMES_HOME?.trim();
  if (!home || !/^~|\$|%[^%]+%/.test(home)) return null;
  return `HERMES_HOME (${home}) holds ~ or variable syntax that hermes expands and this installer does not; set it to a plain path, then re-run`;
}

/**
 * Where hermes keeps its install state, as hermes 0.21.5 derives it (hermes_constants.py get_default_hermes_root and
 * _get_platform_default_hermes_home). Both the platform default and HERMES_HOME's root are returned, so a home that
 * resolves differently is still checked. Checking one root too many refuses a little more often; one too few misses.
 *
 * @returns {string[]} hermes roots to look under, the platform default first
 */
export function hermesRoots({ env, platform, homedir, join, dirname, basename }) {
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
  const base = platform === "win32" ? (env.LOCALAPPDATA?.trim() || join(homedir, "AppData", "Local")) : homedir;
  const native = join(base, platform === "win32" ? `hermes${suffix}` : `.hermes${suffix}`);
  const home = env.HERMES_HOME?.trim();
  if (!home) return [native];
  const parent = dirname(home);
  const custom = basename(parent) === "profiles" ? dirname(parent) : home;
  return custom === native ? [native] : [native, custom];
}

/**
 * Every hermes install on this host that is part-way through an update.
 *
 * ⛔ A CHECK ON HERMES' PRIVATE LAYOUT, read from hermes 0.21.5: pm/environments.py `installs_root()` is
 * `<root>/installs`, `install_state_dir()` is one directory per install, and venv_sync.py `completion_pending_path()`
 * is `source-completion-pending` inside it. Any hermes command run while one exists re-runs that update, so the
 * install must not be what trips it. FINDING ONE REFUSES. FINDING NONE PROVES ONLY that there is none where 0.21.5
 * keeps it: a hermes that moves the marker makes this check go quiet, and the bounded call is what is left.
 *
 * @returns {string[]} the marker paths found
 */
export function pendingUpdateMarkers(roots, { readdir, exists, join }) {
  const found = [];
  for (const root of roots) {
    const installs = join(root, "installs");
    for (const install of readdir(installs)) {
      const marker = join(installs, install, "source-completion-pending");
      if (exists(marker)) found.push(marker);
    }
  }
  return found;
}

/**
 * What `hermes config get mcp_servers.<name>` said, as one of four answers.
 *
 * ⛔ Exit 0 is NOT enough. On an unparseable config hermes exits 0 and answers from its last good read, with the
 * problem on stderr (config-get.txt). So an answer is trusted only with exit 0 AND an empty stderr. Absent is exit 1
 * with "Config key not set: <key>". Anything else is unreadable, and unreadable refuses: it never falls through to a
 * write.
 *
 * @returns {"absent" | "ours" | "theirs" | "unreadable"}
 */
function classifyGet(key, { status, stdout, stderr }) {
  const said = (stderr ?? "").trim();
  if (status === 1 && said === `Config key not set: ${key}`) return "absent";
  if (status !== 0 || said !== "") return "unreadable";
  const ours = (stdout ?? "").split(/\r?\n/).some((line) => line === `${OWNER_KEY}: ${OWNER}`);
  return ours ? "ours" : "theirs";
}

/**
 * The servers in `hermes config get mcp_servers` output that carry our mark.
 *
 * Hermes prints the mapping as block YAML from its own dumper: a server name at column 0, its keys two spaces in
 * (config-get.txt). Only that shape is read, and only to find our mark, so a name is ours only when its own block holds
 * `  x-aify-owner: aify-wrapper`.
 *
 * ⛔ **EVERY line at column 0 ends the entry before it,** whether or not it is a name this reads. A header it did not
 * recognise (`old.service:`, a quoted `'old service':`) once left the previous name current, so the next entry's mark
 * was credited to the operator's entry above it, which was then removed (the senior reviewer, dfb2521). An entry under
 * a header this cannot read is never counted as ours: the installer writes only plain names, and the cost of missing
 * one is an old entry left in place, not someone else's removed.
 */
function ourServers(stdout) {
  const ours = [];
  let current = null;
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      const top = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
      current = top ? top[1] : null;
    } else if (current !== null && line === `  ${OWNER_KEY}: ${OWNER}`) {
      ours.push(current);
    }
  }
  return [...new Set(ours)];
}

/**
 * Whether a set or unset can be counted as done: exit 0 AND an empty stderr, the rule a get answer is held to. A warning
 * may mean the write did not take, and nothing here knows which warnings are harmless, so there is no list of
 * tolerated ones.
 */
const clean = (answer) => answer.status === 0 && (answer.stderr ?? "").trim() === "";

/** The words of a hermes answer worth showing, or a note that it gave none. */
const told = (answer) => (answer.stderr ?? "").trim().slice(0, 300) || "nothing on stderr";

/**
 * Write every entry, or refuse with the step that stopped it.
 *
 * ⛔ **Read and decide everything, then write.** Every `get` comes before the first `set` or `unset`, so a refusal a
 * read can find (another's entry, an unreadable answer) leaves the config exactly as it was. Deciding entry by entry
 * wrote the first server, and removed an old one of ours, before the second turned out to be the operator's.
 * A write that fails part-way is still possible, and is then named with what had already been written.
 *
 * @param {{name: string, value: object}[]} entries  from sessionHermesEntries
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} run
 * @param {string[]} markers  from pendingUpdateMarkers, checked before any hermes call
 * @returns {{ok: true, written: string[], removed: string[]} | {ok: false, step: string, problem: string}}
 */
export function installHermesEntries({ entries, run, markers }) {
  if (markers.length > 0) {
    return {
      ok: false,
      step: "hermes update check",
      problem: `hermes has an interrupted update to finish (${markers.join(", ")}). Run \`hermes update\` from a normal, `
        + "not elevated, terminal, then re-run the installer.",
    };
  }

  // Read: ours that no service opts into any more, then each entry's current owner.
  const all = run(["config", "get", "mcp_servers"]);
  const allAnswer = classifyGet("mcp_servers", all);
  if (allAnswer === "unreadable") {
    return { ok: false, step: "hermes config get mcp_servers", problem: `hermes did not give a readable answer (exit ${all.status}): ${told(all)}` };
  }
  const wanted = new Set(entries.map((entry) => entry.name));
  const toRemove = (allAnswer === "absent" ? [] : ourServers(all.stdout)).filter((name) => !wanted.has(name));
  for (const { name } of entries) {
    const key = `mcp_servers.${name}`;
    const got = run(["config", "get", key]);
    const answer = classifyGet(key, got);
    if (answer === "unreadable") {
      return { ok: false, step: `hermes config get ${key}`, problem: `hermes did not give a readable answer (exit ${got.status}): ${told(got)}` };
    }
    if (answer === "theirs") {
      return { ok: false, step: `hermes config get ${key}`, problem: `the hermes config already has an entry ${name} that this installer did not write; it is left as it is, and nothing was written. Rename or remove it, then re-run.` };
    }
  }

  // Write.
  const removed = [];
  const written = [];
  const sofar = () => `; before this, removed [${removed.join(", ")}] and wrote [${written.join(", ")}]`;
  for (const name of toRemove) {
    const unset = run(["config", "unset", `mcp_servers.${name}`]);
    if (!clean(unset)) return { ok: false, step: `hermes config unset mcp_servers.${name}`, problem: `exit ${unset.status}, so this step cannot say whether it was removed: ${told(unset)}${sofar()}` };
    removed.push(name);
  }
  for (const { name, value } of entries) {
    const key = `mcp_servers.${name}`;
    const set = run(["config", "set", key, JSON.stringify(value)]);
    if (!clean(set)) return { ok: false, step: `hermes config set ${key}`, problem: `exit ${set.status}, so this step cannot say whether it was written: ${told(set)}${sofar()}` };
    written.push(name);
  }
  return { ok: true, written, removed };
}
