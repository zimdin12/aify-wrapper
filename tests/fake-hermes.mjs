// A stand-in for `hermes config get|set|unset`, answering in the shapes hermes 0.21.5 was measured to use
// (aify-dashboard docs/evidence/hermes-session-mcp-2026-10-02/config-get.txt):
//   get of an absent key: exit 1, stderr "Config key not set: <key>"
//   get of a present key: exit 0, block YAML on stdout, nothing on stderr
//   get on an unparseable config: exit 0, the last good answer on stdout, the problem on stderr
//
// State is a JSON file of servers (FAKE_HERMES_STATE); every call is appended to FAKE_HERMES_LOG. FAKE_HERMES_MODE is
// "broken" (the unparseable-config answer) or "fail" (every call exits 2). Values are dumped as hermes dumps them:
// a key per line, nested two spaces in, lists as "- item".

import fs from "node:fs";

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERMES_LOG, `${JSON.stringify(args)}\n`);
const mode = process.env.FAKE_HERMES_MODE ?? "";
if (mode === "fail") {
  process.stderr.write("fake hermes: refusing every call\n");
  process.exit(2);
}
const statePath = process.env.FAKE_HERMES_STATE;
const servers = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(servers));

function dump(value, indent = "") {
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) lines.push(`${indent}${key}:`, ...item.map((entry) => `${indent}  - ${entry}`));
    else if (item && typeof item === "object") lines.push(`${indent}${key}:`, ...dump(item, `${indent}  `));
    else lines.push(`${indent}${key}: ${item}`);
  }
  return lines;
}

const [group, verb, key, value] = args;
if (group !== "config") process.exit(2);
const name = key === "mcp_servers" ? null : key?.replace(/^mcp_servers\./, "");
if (verb === "get") {
  if (mode === "broken") process.stderr.write("Your config.yaml could not be parsed and was not applied. Open it with `hermes config edit`.\n");
  const found = name === null ? (Object.keys(servers).length ? servers : null) : servers[name];
  if (found === undefined || found === null) {
    process.stderr.write(`Config key not set: ${key}\n`);
    process.exit(1);
  }
  process.stdout.write(`${dump(found).join("\n")}\n`);
} else if (verb === "set") {
  servers[name] = JSON.parse(value);
  save();
  process.stdout.write(`Set ${key}\n`);
} else if (verb === "unset") {
  delete servers[name];
  save();
  process.stdout.write(`Unset ${key}\n`);
} else {
  process.exit(2);
}
