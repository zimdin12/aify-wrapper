#!/usr/bin/env node
// The aify side of an ordinary Herdr: claim a pane when a wrapper starts in one, and put the
// wrappers back after Herdr restores a session.
//
//   aify-herdr-pane claim --wrapper claude-aify -- claude-aify --resume
//   aify-herdr-pane restore                       (run by the plugin's [[startup]] hook)
//   aify-herdr-pane status                        (what the ledger holds, for a human)
//
// WHAT MAKES THIS WORK, measured against a live Herdr 0.9.0 rather than inferred:
//
//   1. A pane's shell gets HERDR_PANE_ID, so `claim` knows which pane it is in.
//   2. Reporting the agent under `herdr:aify` -- a source Herdr's allowlist does not contain --
//      makes Herdr persist NO agent session for that pane, so it restores as an empty shell instead
//      of relaunching a bare `claude`. Panes running bare agents are untouched and keep native
//      resume, which is the half of the contract that must not regress.
//   3. The pane's `label` IS persisted, and for an aify pane it is the only thing besides `cwd` that
//      survives. So the label carries a record id and the ledger carries the command.
//
// CLAIM NEVER FAILS A LAUNCH. It runs on the path of the operator starting an agent; a Herdr that is
// down, busy or absent must cost the pane its label, never the agent its start. Every failure here
// exits 0 with a line on stderr.

import { randomUUID } from "node:crypto";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { herdr, listPanes } from "../lib/herdr-cli.mjs";
import { paneLabel, parsePaneLabel, readPaneContext, renamePaneArgv, reportAgentArgv } from "../lib/herdr-pane.mjs";
import { HerdrPaneLedger, restorePlan } from "../lib/herdr-restore.mjs";

/** A short record id: unique per pane, and legal inside a colon-delimited label. */
function mintRecordId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function note(message) {
  process.stderr.write(`aify-herdr-pane: ${message}\n`);
}

/**
 * Claim the pane this wrapper was launched in.
 *
 * THE ORDER IS DELIBERATE: label first, then record, then report. The label is what a later restore
 * matches on, so a crash between steps leaves a labelled pane with no record (harmless -- the
 * restore skips it) rather than a record pointing at a pane nobody can find.
 */
function claim({ wrapper, argv, env = process.env, ledger }) {
  const context = readPaneContext(env);
  if (!context) return { claimed: false, why: "not running in a herdr pane" };
  if (argv.length === 0) return { claimed: false, why: "no wrapper argv to record" };

  const record = mintRecordId();
  const label = paneLabel({ wrapper, record });

  const renamed = herdr(renamePaneArgv({ paneId: context.paneId, label }), { env });
  if (!renamed.ok) return { claimed: false, why: `could not label the pane: ${renamed.error}` };

  ledger.load().remember(record, {
    wrapper,
    argv,
    cwd: process.cwd(),
    workspaceId: context.workspaceId,
    recordedAt: new Date().toISOString(),
  });
  ledger.save();

  // Reported LAST because this is the step that denies the pane a native resume plan. Doing it
  // before the record existed would leave a pane that neither Herdr nor we would bring back.
  const reported = herdr(reportAgentArgv({ paneId: context.paneId, wrapper }), { env });
  if (!reported.ok) return { claimed: true, record, label, why: `labelled, but the agent report failed: ${reported.error}` };
  return { claimed: true, record, label, why: null };
}

/**
 * Put the wrappers back into the panes Herdr restored as empty shells.
 *
 * A FAILED LISTING PRUNES NOTHING. "Herdr told me there are no panes" and "I could not ask Herdr"
 * look identical downstream, and acting on the second would delete every record on the host.
 */
function restore({ env = process.env, ledger }) {
  const listing = listPanes({ env });
  if (!listing.ok) return { restored: [], why: `could not read the pane list: ${listing.error}` };

  ledger.load();
  const plan = restorePlan({ panes: listing.panes, records: ledger.all() });
  const restored = [];
  for (const entry of plan) {
    const sent = herdr(["pane", "run", entry.paneId, ...entry.argv], { env });
    if (sent.ok) restored.push(entry);
    else note(`could not relaunch ${entry.wrapper} in ${entry.paneId}: ${sent.error}`);
  }

  // Only now, against a listing we actually read, is it safe to forget records nothing claims.
  ledger.pruneTo(listing.panes.map(pane => pane?.label).filter(Boolean));
  ledger.save();
  return { restored, why: null };
}

/**
 * Link the aify plugin into the operator's Herdr, which is what makes the restore actually run.
 *
 * EXPLICIT RATHER THAN AN INSTALLER SIDE EFFECT. This writes into the operator's own Herdr config,
 * and a launcher install quietly registering a plugin there is a change they did not ask for and
 * would not find later. `herdr plugin unlink` reverses it.
 *
 * WITHOUT THIS STEP EVERYTHING ELSE STILL "WORKS" AND NOTHING RESTORES: wrappers label their panes,
 * the ledger fills up, Herdr declines the resume exactly as designed -- and no startup hook ever
 * runs. That is the silent half-installed state this command exists to make a single visible action.
 */
function installPlugin({ env = process.env } = {}) {
  const pluginDir = fileURLToPath(new URL("../herdr-plugin/", import.meta.url));
  const linked = herdr(["plugin", "link", pluginDir], { env });
  return { ok: linked.ok, pluginDir, error: linked.error };
}

function status({ env = process.env, ledger }) {
  const listing = listPanes({ env });
  const live = new Map();
  for (const pane of listing.panes) {
    const parsed = parsePaneLabel(pane?.label);
    if (parsed) live.set(parsed.record, pane.pane_id);
  }
  const rows = [...ledger.load().all().entries()].map(([record, entry]) => ({
    record,
    wrapper: entry.wrapper,
    cwd: entry.cwd,
    pane: live.get(record) || null,
  }));
  return { herdrReadable: listing.ok, rows };
}

/**
 * `<command> [--wrapper <name>] [-- <argv...>]`.
 *
 * EVERYTHING AFTER `--` IS THE WRAPPER'S OWN COMMAND and is taken verbatim, because that argv is
 * what a restore replays. Parsing it would mean re-emitting it later from a parse, and a wrapper
 * invocation that survives a reboot only if this module understood its flags is a wrapper
 * invocation that will not survive a reboot.
 */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const separator = rest.indexOf("--");
  const flags = separator === -1 ? rest : rest.slice(0, separator);
  const wrapperArgv = separator === -1 ? [] : rest.slice(separator + 1);
  const wrapperFlag = flags.indexOf("--wrapper");
  return {
    command: command ?? null,
    wrapper: wrapperFlag === -1 ? null : flags[wrapperFlag + 1] ?? null,
    argv: wrapperArgv,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const ledger = new HerdrPaneLedger();

  if (options.command === "claim") {
    if (!options.wrapper) {
      note("claim needs --wrapper <name>");
      return 0;
    }
    let result;
    try {
      result = claim({ wrapper: options.wrapper, argv: options.argv, ledger });
    } catch (err) {
      note(`claim failed, continuing without it: ${err?.message || err}`);
      return 0;
    }
    if (result.why) note(result.why);
    else note(`claimed ${result.label}`);
    return 0;
  }

  if (options.command === "restore") {
    const result = restore({ ledger });
    if (result.why) {
      note(result.why);
      return 1;
    }
    note(`restored ${result.restored.length} pane(s)`);
    for (const entry of result.restored) note(`  ${entry.paneId} <- ${entry.argv.join(" ")}`);
    return 0;
  }

  if (options.command === "install") {
    const result = installPlugin();
    if (!result.ok) {
      note(`could not link the plugin at ${result.pluginDir}: ${result.error}`);
      return 1;
    }
    note(`linked the aify plugin from ${result.pluginDir}`);
    note("aify panes will be restored at the next Herdr start; 'herdr plugin unlink aify.wrappers' undoes it");
    return 0;
  }

  if (options.command === "status") {
    const result = status({ ledger });
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    return 0;
  }

  process.stdout.write("usage: aify-herdr-pane <install | claim --wrapper <name> -- <argv...> | restore | status>\n");
  return options.command ? 2 : 0;
}

export { claim, restore, status, installPlugin, parseArgs };

// RUN ONLY WHEN INVOKED AS THE PROGRAM. Comparing `import.meta.url` to a hand-built `file://` string
// is wrong on Windows, where the real URL is `file:///C:/...`; `pathToFileURL` produces the spelling
// Node itself used, so importing this module from a test stays inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
