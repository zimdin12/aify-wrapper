// The private layout an integrated Herdr invocation owns, and the context file aify-env reads.
//
// WHY THIS LIVES IN THE WRAPPER. The operator settled the split: launch and process lifetime belong
// to aify-wrapper, worker and PTY authority stays in aify-env. Minting the invocation is launch, so
// it is here; everything this file writes is read by `aify-env`'s `readInstanceContext`, which is the
// authority on the shape and rejects anything that disagrees with it.
//
// IT IS A CONTRACT WITH A STRICT READER, which is why the paths are derived rather than configured.
// That reader requires an exact field set, a root whose basename is the invocation and whose parent
// is named `invocations`, each private file at its exact name, and the platform's exact endpoint
// spelling. A configurable path here would be a way to mint a context the daemon refuses, with the
// failure landing at daemon startup instead of at the call that got it wrong.
//
// SINGLE USE BY CONSTRUCTION. The daemon refuses a context whose `owned-processes.json`, `ready.json`
// or `claimed.json` already exists. So an invocation directory is consumed the moment a daemon boots
// in it, and a later launcher physically cannot rebind an old one — which is the no-resurrection
// requirement enforced by the filesystem rather than by remembering to check.
//
// NOTHING HERE STARTS, CONNECTS TO, OR SIGNALS ANYTHING. Importing this module is inert, and every
// function is pure apart from the one that writes the two files it documents.

import path from "node:path";
import fs from "node:fs";

/** The daemon accepts version 1 only; a bump is a coordinated change in both repos. */
export const CONTEXT_VERSION = 1;

/** An empty registry is the only one dedicated mode accepts while scope propagation is unfinished. */
export const EMPTY_SERVICE_REGISTRY = { version: 1, services: {} };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_REF = /^[a-zA-Z0-9_-]+$/;

/**
 * Every private path of one invocation.
 *
 * SEPARATE FROM THE CONTEXT because the launcher needs two of these before it has a context at all:
 * it serves the owner endpoint before the daemon exists, and it reads the readiness receipt after.
 */
export function instancePaths({ profileRoot, invocation, platform = process.platform }) {
  if (!path.isAbsolute(String(profileRoot || ""))) throw new Error("herdr_instance: absolute profile root required");
  if (!UUID.test(String(invocation || ""))) throw new Error("herdr_instance: invocation must be a v4 uuid");
  const root = path.join(path.resolve(profileRoot), "invocations", invocation);
  const pipe = name => `\\\\.\\pipe\\aify-herdr-${name}-${invocation}`;
  return Object.freeze({
    root,
    contextFile: path.join(root, "instance.json"),
    processRecord: path.join(root, "owned-processes.json"),
    serviceRegistry: path.join(root, "services.json"),
    readinessEndpoint: path.join(root, "ready.json"),
    claimed: path.join(root, "claimed.json"),
    ownerEndpoint: platform === "win32" ? pipe("owner") : path.join(root, "owner.sock"),
    herdrApiEndpoint: platform === "win32" ? pipe("api") : path.join(root, "herdr.sock"),
  });
}

/**
 * The exact twelve fields `readInstanceContext` accepts, and no others.
 *
 * `takeover` and `recovery` are constants rather than options on purpose. A dedicated instance that
 * could take over would be able to supersede the env already serving this machine and reap its
 * workers, which has taken this fleet down more than once; a dedicated instance that could recover
 * would resurrect a previous invocation's agents, which the operator ruled out explicitly.
 */
export function buildInstanceContext({ profileRoot, invocation, profileRef, platform = process.platform }) {
  if (!PROFILE_REF.test(String(profileRef || ""))) throw new Error("herdr_instance: profileRef must be [A-Za-z0-9_-]+");
  const paths = instancePaths({ profileRoot, invocation, platform });
  return Object.freeze({
    version: CONTEXT_VERSION,
    invocation,
    scope: `herdr-${invocation}`,
    root: paths.root,
    processRecord: paths.processRecord,
    serviceRegistry: paths.serviceRegistry,
    ownerEndpoint: paths.ownerEndpoint,
    readinessEndpoint: paths.readinessEndpoint,
    herdrApiEndpoint: paths.herdrApiEndpoint,
    profileRef,
    takeover: "refuse",
    recovery: "none",
  });
}

/**
 * Create the invocation directory and write ONLY the two files the daemon expects to find.
 *
 * IT MUST NOT CREATE THE OTHER THREE. `owned-processes.json`, `ready.json` and `claimed.json` are
 * the daemon's to publish exclusively at readiness, and their prior existence is exactly how it
 * detects a reused invocation. Writing one here as a placeholder would make every launch look used.
 */
export function writeInstanceContext(context, { io = fs } = {}) {
  // DERIVED FROM `root`, NOT CARRIED. The context is exactly the twelve fields the reader accepts,
  // and its own path is not one of them — the reader locates it the same way, by requiring the file
  // to be `instance.json` inside the root it names. Adding a thirteenth field to hold the path would
  // be refused as an unsupported field, so there is one spelling of this and it is this one.
  const contextFile = path.join(context.root, "instance.json");
  io.mkdirSync(context.root, { recursive: true, mode: 0o700 });
  io.writeFileSync(context.serviceRegistry, `${JSON.stringify(EMPTY_SERVICE_REGISTRY)}\n`, { flag: "wx", mode: 0o600 });
  io.writeFileSync(contextFile, `${JSON.stringify(context)}\n`, { flag: "wx", mode: 0o600 });
  return contextFile;
}

/**
 * The environment the dedicated daemon is started with.
 *
 * ADVERTISEMENT OFF IS A DAEMON PRECONDITION, not a preference: `prepareInstance` refuses to boot
 * unless `AIFY_ADVERTISE` is exactly "0", because a dedicated instance that advertised would publish
 * a second claimer for this host while scope propagation is still unbuilt.
 *
 * HOME, USERPROFILE, APPDATA and XDG ARE DELIBERATELY UNTOUCHED. Redirecting them would reach every
 * shell, wrapper and agent started under this Herdr and detach them from their real profiles; the
 * isolation that is wanted is Herdr's own roots, which are set by their own variables.
 */
export function dedicatedDaemonEnv(base, context) {
  return { ...base, AIFY_ADVERTISE: "0", AIFY_HERDR_INVOCATION: context.invocation };
}
