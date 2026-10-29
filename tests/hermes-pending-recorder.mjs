// An install recording a hermes config change from its own process, as install.sh does
// (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-recorder.mjs <marker> <registry> <config target> [log]
//
// With a log, it says what happened at the lock: `contend` the first time its attempt finds the lock held, and
// `recorded` once its record is written, so a test can wait on the record reaching the lock rather than on a sleep.

import fs from "node:fs";

import { PendingHermesConfig } from "../lib/hermes-pending-config.mjs";

const [marker, registry, target, log] = process.argv.slice(2);
const say = (word) => log && fs.appendFileSync(log, `${word}\n`);
let contended = false;
const io = {
  ...fs,
  writeFileSync(file, data, options) {
    try {
      return fs.writeFileSync(file, data, options);
    } catch (error) {
      if (error?.code === "EEXIST" && file === `${marker}.lock` && !contended) { contended = true; say("contend"); }
      throw error;
    }
  },
};
new PendingHermesConfig({ marker, lock: { io } }).record(registry, target);
say("recorded");
