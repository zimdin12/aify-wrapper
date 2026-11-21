// A package artifact from git: installed with npm at the spec's exact revision, then checked against what npm says
// it installed before any entry may point into it.
//
// WITH SCRIPTS. The dashboard's bridge builds in `prepare`; `--ignore-scripts` yields a package with no dist/
// (the dashboard maintainer, guided install S1). `--ignore-scripts=false` is passed explicitly so an operator's npmrc
// cannot turn it off.
//
// INTO ITS OWN PREFIX, ONE PER SERVICE AND REVISION, NOT `-g`: no global npm state is touched, a reconnect that fails
// cannot touch the files the live entry runs, and the prefix's lockfile records the commit, whose `resolved` ends in
// `#<commit>` (`npm ls -g --json --long` reported none, npm 10.9.3, 2026-10-20). Seen on the way, and PROVEN ONLY for
// a `git+file` bare repository on npm 10.9.3: `-g` of a package with `prepare` left a link into a deleted
// _cacache/tmp/git-clone directory. A real `npm install -g github:...` of the dashboard builds dist/ and serves
// (aify-dashboard docs/evidence/bridge-git-source-2026-10-20), so that is not a claim about github specs.
//
// The pure checks are exported; installPackage owns the filesystem and calls npm through the `npm` it is given.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { skillDirectory } from "aify-env/client/installed-skills";

export { npmCliBeside } from "./npm-cli.mjs";

/** What npm is asked to install: the spec's repository at its full commit, nothing the spec could widen. */
const installSpec = (git) => `github:${git.repo}#${git.revision}`;

export const installArgs = (prefix, git) => ["install", "--prefix", prefix, "--ignore-scripts=false", "--no-audit", "--no-fund", "--omit=optional", installSpec(git)];

/**
 * The single package `npm ls --json --long` reports in an artifact's own prefix, and the commit its `resolved` names.
 *
 * @returns {{name?: string, commit?: string, problem: string}}
 */
export function installedCommit(ls) {
  const deps = Object.entries(ls?.dependencies ?? {});
  if (deps.length !== 1) return { problem: `npm reports ${deps.length} packages in the artifact's prefix, not 1` };
  const [[name, dep]] = deps;
  const commit = /#([0-9a-f]{40})$/.exec(String(dep?.resolved ?? ""))?.[1];
  if (!commit) return { name, problem: `npm reports no commit for ${name} (resolved ${JSON.stringify(dep?.resolved ?? null)})` };
  return { name, commit, problem: "" };
}

/**
 * Each entry's file from the installed package.json's `bin` map: an entry is a bin the package declares, never a
 * path the spec names.
 *
 * @returns {{files: Record<string,string>, problems: string[]}}  entry -> path relative to the package directory
 */
export function binFiles(pkg, entries) {
  const declared = typeof pkg?.bin === "string" ? { [String(pkg.name).replace(/^@[^/]+\//, "")]: pkg.bin } : pkg?.bin ?? {};
  const files = {};
  const problems = [];
  for (const entry of entries) {
    const file = typeof declared[entry] === "string" ? declared[entry].replace(/^\.\//, "") : "";
    if (!file) problems.push(`${entry} is not a bin ${pkg?.name ?? "the package"} declares (it declares ${Object.keys(declared).join(", ") || "none"})`);
    else if (/^[\\/]|^[A-Za-z]:|\\|(^|\/)\.\.(\/|$)/.test(file)) problems.push(`${entry}'s bin ${JSON.stringify(file)} leaves the package`);
    else files[entry] = file;
  }
  return { files, problems };
}

/**
 * Install `artifact` (a package from git) under `root`/<revision>, or reuse that directory when it already holds the
 * revision. Throws `Fail` with every problem; a directory this call created is removed on failure.
 *
 * @param {{artifact: object, root: string, npm: (args: string[]) => string, Fail: typeof Error}} o
 * @returns {{root: string, files: Record<string,string>, reused: boolean}}  root is the package directory
 */
export function installPackage({ artifact, root, npm, Fail }) {
  const git = artifact.source.git;
  const final = path.join(root, git.revision);
  if (fs.existsSync(final)) {
    const verdict = verify(final, git, artifact.entries, npm);
    if (!verdict.problems.length) return { ...verdict.at, reused: true };
    throw new Fail(`${artifact.id}: ${final} does not hold ${git.repo}@${git.revision}: ${verdict.problems.join("; ")}`);
  }
  const partial = `${final}.partial-${randomBytes(4).toString("hex")}`;
  fs.mkdirSync(partial, { recursive: true });
  try {
    npm(installArgs(partial, git));
    const verdict = verify(partial, git, artifact.entries, npm);
    if (verdict.problems.length) throw new Fail(`${artifact.id}: the install of ${installSpec(git)} is refused: ${verdict.problems.join("; ")}`);
    fs.renameSync(partial, final);
    if (artifact.entries.length) return { ...verify(final, git, artifact.entries, npm).at, reused: false };
    // For a skill package the rename moves the exact directory we just checked.
    const dir = path.join(final, path.relative(partial, verdict.at.root));
    return { ...verdict.at, root: dir.split(path.sep).join("/"), reused: false };
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Package names identify node_modules paths, not declared skill paths. No leading dot or spaces.
const packageNamePart = (name) => /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(name)
  && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);

function skillPackageDeclaration(pkg, installedName) {
  if (!object(pkg) || pkg.name !== installedName) return { problem: "package.json does not identify the installed package" };
  if ((Object.hasOwn(pkg, "bin") && !(object(pkg.bin) && !Object.keys(pkg.bin).length)) || pkg.directories?.bin !== undefined) {
    return { problem: "an empty entries list is only for packages that declare no bins" };
  }
  const directory = skillDirectory(pkg.aifySkills);
  if (!directory) return { problem: "an empty entries list requires aifySkills with one portable package-relative directory" };
  return { directory };
}

function verifySkillPackage(prefix, name) {
  const parts = name.split("/");
  const validName = parts.length === 1 && packageNamePart(parts[0])
    || parts.length === 2 && parts[0].startsWith("@") && packageNamePart(parts[0].slice(1)) && packageNamePart(parts[1]);
  if (!validName) return { problems: ["npm did not report a portable package name"] };
  const packageParts = ["node_modules", ...parts];
  const dir = path.join(prefix, ...packageParts);
  const manifest = path.join(dir, "package.json");
  try {
    if (!isDirectoryChain(prefix, packageParts) || !fs.lstatSync(manifest).isFile()) {
      return { problems: ["the installed skill package or its package.json is not a regular path in the prefix"] };
    }
    const { directory, problem } = skillPackageDeclaration(JSON.parse(fs.readFileSync(manifest, "utf8")), name);
    if (problem) return { problems: [problem] };
    if (!isDirectoryChain(dir, directory.split("/"))) {
      return { problems: ["aifySkills.directory is not an existing, unlinked directory in the installed package"] };
    }
  } catch (error) {
    return { problems: [`the installed skill package is unreadable (${error.code ?? error.name})`] };
  }
  return { problems: [], at: { root: dir.split(path.sep).join("/"), files: {} } };
}

function isDirectoryChain(root, parts) {
  if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return false;
  let dir = root;
  return parts.every((part) => {
    dir = path.join(dir, part);
    return fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory();
  });
}

function verify(prefix, git, entries, npm) {
  const installed = installedCommit(JSON.parse(npm(["ls", "--prefix", prefix, "--json", "--long", "--depth=0"]) || "{}"));
  if (installed.problem) return { problems: [installed.problem] };
  if (installed.commit !== git.revision) return { problems: [`npm installed ${installed.commit}, not the spec's revision ${git.revision}`] };
  if (entries.length === 0) return verifySkillPackage(prefix, installed.name);
  const dir = path.join(prefix, "node_modules", installed.name);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    return { problems: [`${installed.name}'s package.json is unreadable (${error.code ?? error.message})`] };
  }
  const { files, problems } = binFiles(pkg, entries);
  for (const [entry, file] of Object.entries(files)) {
    if (!fs.existsSync(path.join(dir, file))) problems.push(`${entry}'s bin ${file} is not on disk; a build that did not run leaves this`);
  }
  return { problems, at: { root: dir.split(path.sep).join("/"), files } };
}

/**
 * npm, run as `node <npm-cli.js>` so no shell is involved. Throws `Fail` on a non-zero exit with npm's last lines,
 * which name a package or a path and never a key.
 */
export function npmTool(npmCli, env, Fail) {
  return (args) => {
    const result = spawnSync(process.execPath, [npmCli, ...args], { env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
      const tail = `${result.stderr || ""}${result.error?.message || ""}`.trim().split(/\r?\n/).slice(-6).join(" | ");
      throw new Fail(`npm ${args[0]} failed (exit ${result.status}): ${tail}`);
    }
    return result.stdout;
  };
}
