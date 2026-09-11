#!/usr/bin/env node
// The aify side of an ordinary Herdr: claim a pane when a wrapper starts in one, and put the
// wrappers back after Herdr restores a session.
//
//   aify-herdr-pane install                        link the plugin (once per machine)
//   aify-herdr-pane claim --wrapper claude-aify -- claude-aify --resume
//   aify-herdr-pane restore                        run by the plugin's [[startup]] hook
//   aify-herdr-pane status                         what the ledger holds, for a human
//
// WHAT MAKES THIS WORK, measured against a live Herdr 0.9.0 rather than inferred:
//
//   1. A pane's shell gets HERDR_PANE_ID, so `claim` knows which pane it is in.
//   2. Reporting the agent under `herdr:aify` -- a source Herdr's allowlist does not contain --
//      makes Herdr persist NO agent session for that pane, so it restores as an empty shell instead
//      of relaunching a bare `claude`. Panes running bare agents keep native resume, untouched.
//   3. The pane's `label` IS persisted, and is the only durable handle. The ledger carries the rest.
//
// CLAIM NEVER FAILS A LAUNCH, and it must not STALL one either. It runs on the path of the operator
// starting an agent, so every Herdr call here is bounded well below the library default: a wedged
// Herdr used to cost 30 seconds of dead terminal before the agent started, with the reason discarded.

import { randomUUID } from "node:crypto";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { herdr, listPanes } from "../lib/herdr-cli.mjs";
import { paneLabel, parsePaneLabel, readPaneContext, renamePaneArgv, reportAgentArgv } from "../lib/herdr-pane.mjs";
import { replayCommand } from "../lib/herdr-replay.mjs";
import { HerdrPaneLedger, restorePlan } from "../lib/herdr-restore.mjs";

/** An operator waiting to start an agent gets at most this long per Herdr call, twice. */
const CLAIM_TIMEOUT_MS = 4000;

/** A short record id: unique per pane, and legal inside a colon-delimited label. */
function mintRecordId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function note(message) {
  process.stderr.write(`aify-herdr-pane ${new Date().toISOString()}: ${message}\n`);
}

/** The pane row Herdr currently holds for one pane, which is where `terminal_id` comes from. */
function readPane(paneId, { env, timeoutMs }) {
  const listing = listPanes({ env, timeoutMs });
  if (!listing.ok) return { ok: false, pane: null, error: listing.error };
  const pane = listing.panes.find(row => String(row?.pane_id) === paneId);
  if (!pane) return { ok: false, pane: null, error: `herdr does not list pane ${paneId}` };
  return { ok: true, pane, error: null };
}

/**
 * Claim the pane this wrapper was launched in.
 *
 * THE PTY IS READ FIRST, because a record without the pane's `terminal_id` cannot be restored
 * safely: the restore decides whether a pane is free by comparing that id, so a record missing it
 * would either be refused later or -- worse, in the version this replaced -- relaunched into a live
 * agent. No terminal id, no claim.
 *
 * THE LABEL IS ROLLED BACK IF THE REPORT FAILS. A pane that is labelled but never reported under
 * `herdr:aify` is the WORST outcome available: Herdr's own hook is then free to claim it, the pane
 * natively resumes a BARE agent on reboot, and our record sits unused. That is precisely the failure
 * this feature exists to prevent, so a half-claim is undone rather than left.
 */
function claim({ wrapper, argv, env = process.env, ledger }) {
  const context = readPaneContext(env);
  if (!context) return { claimed: false, why: "not running in a herdr pane" };
  if (argv.length === 0) return { claimed: false, why: "no wrapper argv to record" };

  const options = { env, timeoutMs: CLAIM_TIMEOUT_MS };
  const before = readPane(context.paneId, options);
  if (!before.ok) return { claimed: false, why: `could not read the pane: ${before.error}` };
  const terminalId = before.pane.terminal_id == null ? "" : String(before.pane.terminal_id);
  if (!terminalId) return { claimed: false, why: "herdr reported no terminal id for this pane" };

  // REFUSED EARLY rather than recorded and refused at restore. An argv this cannot replay safely
  // would produce a labelled pane that never comes back, and the reason would only surface after a
  // reboot -- so it is said now, into the log, while the operator could still act on it.
  const replay = replayCommand(argv);
  if (!replay.ok) return { claimed: false, why: `this invocation cannot be replayed safely: ${replay.why}` };

  const record = mintRecordId();
  const label = paneLabel({ wrapper, record });

  const renamed = herdr(renamePaneArgv({ paneId: context.paneId, label }), options);
  if (!renamed.ok) return { claimed: false, why: `could not label the pane: ${renamed.error}` };

  const reported = herdr(reportAgentArgv({ paneId: context.paneId, wrapper }), options);
  if (!reported.ok) {
    // Undo the label so this pane is not left in the half-claimed state described above.
    const undone = herdr(["pane", "rename", context.paneId, ""], options);
    return {
      claimed: false,
      why:
        `the agent report failed (${reported.error}), so the label was ` +
        `${undone.ok ? "rolled back" : "LEFT BEHIND — this pane may resume a bare agent"}`,
    };
  }

  // RECORDED LAST, once the pane is fully ours. A record written before the report could describe a
  // pane Herdr had already given to its own hook.
  ledger.load();
  if (ledger.unreadable) return { claimed: false, why: "the ledger is unreadable, so nothing was recorded" };
  ledger.remember(record, {
    wrapper,
    argv,
    terminalId,
    cwd: process.cwd(),
    workspaceId: context.workspaceId,
    recordedAt: new Date().toISOString(),
  });
  const saved = ledger.save();
  if (!saved.saved) return { claimed: false, why: `the pane is claimed but nothing was recorded: ${saved.why}` };
  return { claimed: true, record, label, why: null };
}

/**
 * Put the wrappers back into the panes Herdr restored as empty shells.
 *
 * A FAILED LISTING PRUNES NOTHING, and neither does an empty one -- both are handled by the ledger's
 * own refusal, because "Herdr has no panes" and "I could not ask properly" are the same observation.
 *
 * THE LEDGER IS RE-READ BEFORE PRUNING. Each relaunch starts a wrapper that claims its pane and
 * writes its OWN record; pruning against the snapshot taken before the relaunches deleted exactly
 * those records, so the feature worked once per pane and then silently stopped forever.
 */
function restore({ env = process.env, ledger, cli = { herdr, listPanes } }) {
  const listing = cli.listPanes({ env });
  if (!listing.ok) return { restored: [], refused: [], why: `could not read the pane list: ${listing.error}` };

  ledger.load();
  if (ledger.unreadable) return { restored: [], refused: [], why: "the ledger is unreadable; nothing was changed" };

  const byPane = new Map(listing.panes.map(pane => [String(pane?.pane_id), pane]));
  const plan = restorePlan({ panes: listing.panes, records: ledger.all() });
  const restored = [];
  const refused = [];
  for (const entry of plan) {
    const replay = replayCommand(entry.argv);
    if (!replay.ok) {
      refused.push({ paneId: entry.paneId, why: replay.why });
      continue;
    }
    const sent = cli.herdr(["pane", "run", entry.paneId, replay.text], { env });
    if (sent.ok) restored.push(entry);
    else refused.push({ paneId: entry.paneId, why: sent.error });
  }

  // RE-READ, so records the relaunched wrappers have just written are seen rather than overwritten.
  ledger.load();
  if (ledger.unreadable) return { restored, refused, why: "relaunched, but the ledger became unreadable" };

  // THE RECORD NOW POINTS AT THE PANE'S CURRENT PTY, which is what stops this pass from being
  // repeatable against the same pane. FOUND BY RUNNING IT, not by a unit test: after a restore the
  // record still named the PRE-RESTART terminal, so the pane kept looking free and a second pass --
  // the operator's `restore` action, or a live handoff seconds later -- typed the command in again.
  //
  // Normally the relaunched wrapper claims the pane itself within a second or two and supersedes
  // this; this closes the window in between, and closes it permanently when that claim never lands.
  for (const entry of restored) {
    const held = ledger.get(entry.record);
    const pane = byPane.get(entry.paneId);
    const terminalId = pane?.terminal_id == null ? "" : String(pane.terminal_id);
    if (held && terminalId) ledger.remember(entry.record, { ...held, terminalId });
  }
  const pruned = ledger.pruneTo(listing.panes.map(pane => pane?.label).filter(Boolean));
  const saved = ledger.save();
  return {
    restored,
    refused,
    pruned: pruned.pruned,
    prunedRefused: pruned.refused,
    why: saved.saved ? null : saved.why,
  };
}

/**
 * Link the aify plugin into the operator's Herdr, which is what makes the restore actually run.
 *
 * EXPLICIT RATHER THAN AN INSTALLER SIDE EFFECT. This writes into the operator's own Herdr config,
 * and a launcher install quietly registering a plugin there is a change they did not ask for and
 * would not find later. `herdr plugin unlink aify.wrappers` reverses it.
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
    if (parsed) live.set(parsed.record, pane);
  }
  ledger.load();
  const rows = [...ledger.all().entries()].map(([record, entry]) => {
    const pane = live.get(record);
    return {
      record,
      wrapper: entry.wrapper,
      cwd: entry.cwd,
      pane: pane ? String(pane.pane_id) : null,
      // A pane whose PTY still matches the record is one the wrapper is presumably still running in.
      stillInItsOriginalTerminal: pane ? String(pane.terminal_id || "") === entry.terminalId : null,
    };
  });
  return { herdrReadable: listing.ok, ledger: ledger.file, ledgerReadable: !ledger.unreadable, rows };
}

/**
 * `<command> [--wrapper <name>] [-- <argv...>]`.
 *
 * EVERYTHING AFTER `--` IS THE WRAPPER'S OWN COMMAND and is taken verbatim, because that argv is
 * what a restore replays. Parsing it would mean re-emitting it later from a parse, and an invocation
 * that survives a reboot only if this module understood its flags is one that will not.
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
    note(result.why ? `not claimed: ${result.why}` : `claimed ${result.label}`);
    return 0;
  }

  if (options.command === "restore") {
    let result;
    try {
      result = restore({ ledger });
    } catch (err) {
      note(`restore failed: ${err?.message || err}`);
      return 1;
    }
    if (result.why) note(result.why);
    note(`restored ${result.restored.length} pane(s)`);
    for (const entry of result.restored) note(`  ${entry.paneId} <- ${entry.argv.join(" ")}`);
    for (const entry of result.refused) note(`  REFUSED ${entry.paneId}: ${entry.why}`);
    if (result.prunedRefused) note(`  kept ${result.prunedRefused} record(s): the pane listing was empty`);
    return result.why ? 1 : 0;
  }

  if (options.command === "status") {
    try {
      process.stdout.write(`${JSON.stringify(status({ ledger }), null, 1)}\n`);
    } catch (err) {
      note(`status failed: ${err?.message || err}`);
      return 1;
    }
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

  process.stdout.write("usage: aify-herdr-pane <install | claim --wrapper <name> -- <argv...> | restore | status>\n");
  return options.command ? 2 : 0;
}

export { claim, restore, status, installPlugin, parseArgs, CLAIM_TIMEOUT_MS };

// RUN ONLY WHEN INVOKED AS THE PROGRAM. Comparing `import.meta.url` to a hand-built `file://` string
// is wrong on Windows, where the real URL is `file:///C:/...`; `pathToFileURL` produces the spelling
// Node itself used, so importing this module from a test stays inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
