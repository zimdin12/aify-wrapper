// Is an installed launcher still built from the registry this host has?
//
// THIS EXISTS BECAUSE THE FINGERPRINT HAD NO READER. It was baked into every launcher and printed by
// `--check`, and the phase gate claimed a stale launcher "reports itself stale" — while nothing
// anywhere compared it to anything. A value written and displayed is not a check; it is a value.
// Severity comes from the consumer, and until this module there was no consumer.
//
// READS, NEVER RUNS. A launcher is judged from its text. Asking a pre-contract wrapper about itself by
// executing it is how a four-second probe once superseded a live environment bridge and reaped a
// managed fleet — the same rule that has the allowlist read a marker instead of running the file.
//
// THREE STATES, not two. "I could not tell" is its own answer: a launcher installed before this
// existed carries no fingerprint, and reading its absence as agreement would report the population
// most likely to be stale as fine.

/** Anchored to a line start and required to be an assignment, so a mention is not a declaration. */
const FINGERPRINT_PATTERN = /^[ \t]*HARNESS_REGISTRY_FINGERPRINT[ \t]*=[ \t]*"([^"]*)"[ \t]*$/m;

/**
 * The registry digest a launcher was built from, or null when it does not declare one.
 *
 * Null rather than "", so a caller testing truthiness gets one answer for absent — and so an EMPTY
 * value reads as "nobody looked" rather than as agreement with a host that has no services, which has
 * a real digest of its own.
 */
export function launcherFingerprint(text) {
  if (typeof text !== "string") return null;
  const match = FINGERPRINT_PATTERN.exec(text);
  if (!match) return null;
  const value = match[1].trim();
  return value === "" ? null : value;
}

/**
 * Compare installed launchers against the registry this host has now.
 *
 * @param {{launchers: {name: string, text: string}[], registryFingerprint: string}} input
 * @returns {{ok: boolean, current: object[], stale: object[], unknown: object[], summary: string}}
 */
export function stalenessOf({ launchers = [], registryFingerprint = "" } = {}) {
  const current = [];
  const stale = [];
  const unknown = [];

  for (const launcher of launchers) {
    const installed = launcherFingerprint(launcher.text);
    if (installed === null || registryFingerprint === "") {
      unknown.push({ name: launcher.name, installed, expected: registryFingerprint || null });
      continue;
    }
    const row = { name: launcher.name, installed, expected: registryFingerprint };
    if (installed === registryFingerprint) current.push(row);
    else stale.push(row);
  }

  if (launchers.length === 0) {
    // A host with nothing installed has nothing verified. Reporting that as current is the false green
    // this family of checks exists to prevent.
    return { ok: false, current, stale, unknown, summary: "no launchers found, so nothing was checked" };
  }

  const parts = [`${current.length} current`];
  if (stale.length) {
    parts.push(`${stale.length} stale (${stale.map((l) => l.name).join(", ")})`);
  }
  if (unknown.length) {
    parts.push(`${unknown.length} unreadable (${unknown.map((l) => l.name).join(", ")})`);
  }

  // REINSTALL, never restart. A launcher has exec'd and gone by the time anything is running, so
  // relaunching an agent changes nothing about it — and sending somebody to restart a fleet for no
  // effect is worse than saying nothing.
  const remedy = stale.length || unknown.length
    ? " — reinstall the affected launchers; relaunching an agent will not change them"
    : "";

  return {
    ok: stale.length === 0 && unknown.length === 0,
    current,
    stale,
    unknown,
    summary: parts.join(", ") + remedy,
  };
}
