#!/usr/bin/env node
// aify-wrapper-connect <service> <url>: register a service on this host from the spec it serves, store its keys
// through aify-env, and re-render the launchers. lib/connect.mjs holds the order and every rule; this file supplies
// the ambient things -- argv, stdin, files, the home directory, where aify-env is -- and prints the result.
//
// Exit codes: 0 published, 78 refused with nothing published, 75 the publish outcome is unknown (staged keys kept).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE, keyFromText, parseConnectArgs } from "../lib/connect-args.mjs";
import { Refused, aifyEnvTools, connect } from "../lib/connect.mjs";
import { credentialFromBytes } from "../lib/credential-file.mjs";
import { writeConnectRecord } from "../lib/connect-report.mjs";
import { npmCliBeside, npmTool } from "../lib/package-install.mjs";

const EXIT_REFUSED = 78;
const EXIT_UNKNOWN = 75;
const WRAPPER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = parseConnectArgs(process.argv.slice(2));
if (args.problem) {
  process.stderr.write(`aify-wrapper-connect: ${args.problem}\n${USAGE}\n`);
  process.exit(EXIT_REFUSED);
}
const [name, endpoint] = args.positional;
const home = os.homedir();

/** npm's global root, where aify-env is installed; asked of npm only when not given. */
function npmRoot() {
  if (args.npmRoot) return args.npmRoot;
  const run = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", timeout: 60_000 });
  return run.status === 0 ? run.stdout.trim() : "";
}

function readKeyFile(file) {
  try {
    return keyFromText(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Refused(`cannot read ${file}: ${error.code ?? error.message}`);
  }
}

try {
  const secrets = {};
  if (args.keyFile) secrets.credentialRef = readKeyFile(args.keyFile);
  if (args.keyStdin) secrets.credentialRef = keyFromText(fs.readFileSync(0, "utf8"));
  for (const [field, file] of Object.entries(args.secretFiles)) secrets[field] = readKeyFile(file);
  for (const [field, value] of Object.entries(secrets)) if (!value) throw new Refused(`the ${field} key supplied is empty`);

  const aifyEnvBin = args.aifyEnv || path.join(npmRoot(), "aify-env", "bin", "aify-env.mjs");
  if (!fs.existsSync(aifyEnvBin)) throw new Refused(`aify-env is not installed (${aifyEnvBin}); install it before connecting a service`);
  const npmCli = args.npmCli || npmCliBeside(process.execPath);
  const catalogue = JSON.parse(fs.readFileSync(path.join(WRAPPER_ROOT, "lib", "artifact-catalogue.json"), "utf8"));

  // Refused before anything is staged or published, never after a commit it would then misreport.
  if (args.reportFile && fs.existsSync(args.reportFile)) throw new Refused(`--report-file ${args.reportFile} exists; give a path that does not`);
  const report = await connect({
    name,
    endpoint,
    secrets,
    approved: new Set([...catalogue.approved, ...args.approve]),
    tools: aifyEnvTools(aifyEnvBin),
    readStored: (ref) => {
      try {
        return credentialFromBytes(fs.readFileSync(path.join(home, ".aify", "credentials", ref)));
      } catch {
        return "";
      }
    },
    registryPath: args.registry || process.env.AIFY_SERVICE_REGISTRY || path.join(home, ".aify", "services.json"),
    dest: args.dest || path.join(home, ".local", "bin"),
    home: home.split(path.sep).join("/"),
    fileSetRoot: args.fileSetRoot,
    packageRoot: args.packageRoot || path.join(home, ".aify", "packages"),
    npm: (npmArgs) => {
      if (!npmCli) throw new Refused(`npm's CLI is not beside ${process.execPath}; pass --npm-cli <path to npm-cli.js>`);
      return npmTool(npmCli, process.env, Refused)(npmArgs);
    },
    execPath: process.execPath.split(path.sep).join("/"),
    stagingDir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-connect-fetched-")),
    wrapperRoot: WRAPPER_ROOT,
    env: process.env,
  });

  // The record a program acts on (lib/connect-report.mjs), written before the prose below, which a spec can shape.
  if (args.reportFile) writeConnectRecord(args.reportFile, report);
  const out = [`connected ${report.service} at ${endpoint}: ${report.result}`];
  for (const warning of report.warnings ?? []) out.push(`  warning (another service, not blocking): ${warning}`);
  for (const field of report.unprobed) out.push(`  ${field}: stored, not probed`);
  for (const field of report.absent ?? []) out.push(`  ${field}: optional, not supplied`);
  for (const server of report.pending) out.push(`  mcp ${server.name}: no entry written -- ${server.reason}`);
  for (const file of report.fetched ?? []) out.push(`  fetched and verified: ${file}`);
  for (const pkg of report.installed ?? []) out.push(`  ${pkg.id}: ${pkg.reused ? "already installed" : "installed"} at ${pkg.at}`);
  for (const extra of report.unlisted ?? []) out.push(`  ${extra.id}: ${extra.count} file(s) on disk not in its manifest, not run by any entry (e.g. ${extra.sample.join(", ")})`);
  for (const old of report.cleanupPending) {
    out.push(`  cleanup-pending: ${old.field} no longer names ${old.ref}; once nothing still reads it: aify-env credential remove --ref=${old.ref}`);
  }
  for (const row of report.launchers) out.push(`  launcher ${row.name}: ${row.state}${row.detail ? ` -- ${row.detail}` : ""}`);
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`aify-wrapper-connect: ${error.message}\n`);
  if (error.report?.unremoved) process.stderr.write(`  staged references not removed: ${error.report.unremoved.join("; ")}\n`);
  process.exit(error.report?.result === "unknown" ? EXIT_UNKNOWN : EXIT_REFUSED);
}
