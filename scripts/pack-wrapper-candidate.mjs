// One pack operation; both release legs consume the resulting file and digest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmCliBeside } from "../lib/npm-cli.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function packCandidate(source, output) {
  const npm = npmCliBeside(process.execPath);
  assert.ok(npm, "NOT_RUN: npm CLI unavailable for packing wrapper candidate");
  const dir = path.dirname(output);
  assert.equal(fs.existsSync(output), false, "NOT_RUN: refusing to overwrite a candidate tarball");
  const [packed] = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", dir],
    { cwd: source, encoding: "utf8" }));
  assert.equal(packed.name, "aify-wrapper", "NOT_RUN: npm packed another package");
  fs.renameSync(path.join(dir, packed.filename), output);
  return sha256(fs.readFileSync(output));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, output] = process.argv;
  try {
    assert.ok(source && output, "usage: pack-wrapper-candidate.mjs <source> <output>");
    console.log(packCandidate(path.resolve(source), path.resolve(output)));
  } catch (error) {
    console.error(`NOT_RUN: wrapper pack: ${error.message}`);
    process.exitCode = 1;
  }
}
