// The launchers this package installs, derived from what it ships rather than typed out: one per template
// (`wrappers/<name>.sh.in`), then each alias `wrappers/aliases` names. install.sh reads the same aliases file.

import fs from "node:fs";
import path from "node:path";

/**
 * Each launcher's aliases, from `wrappers/aliases`: other names it is installed under, as copies of it, in file order.
 * Empty when the file cannot be read.
 */
export function launcherAliases(wrapperRoot) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(wrapperRoot, "wrappers", "aliases"), "utf8");
  } catch {
    return new Map();
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter(([first]) => first && !first.startsWith("#"));
  return new Map(lines.map(([launcher, ...aliases]) => [launcher, aliases]));
}

/** The template launchers, sorted, then the aliases in file order: a fixed order whatever the directory listing gives. */
export function launcherNames(wrapperRoot) {
  const templates = fs.readdirSync(path.join(wrapperRoot, "wrappers")).filter((name) => name.endsWith("-aify.sh.in"))
    .map((name) => name.slice(0, -".sh.in".length)).sort();
  return [...templates, ...[...launcherAliases(wrapperRoot).values()].flat()];
}
