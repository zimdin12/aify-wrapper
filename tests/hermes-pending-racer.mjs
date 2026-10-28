// One of several starts racing to apply the same pending hermes config change, as at "restart all"
// (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-racer.mjs <marker> <log>
//
// Its scan sees what a host restarting its agents shows: launchers, and node waiting at the lock, and no hermes. Its
// step logs `begin` and `end` around a pause. It logs `launch-<outcome>` only after apply returns, which is where a
// launcher would go on to start its hermes.

import fs from "node:fs";

import { PendingHermesConfig } from "../lib/hermes-pending-config.mjs";

const [marker, log] = process.argv.slice(2);
const say = (word) => fs.appendFileSync(log, `${word} ${process.pid}\n`);
const WAITING = new Map([
  [11, { pid: 11, commandLine: '"C:\\Program Files\\Git\\usr\\bin\\bash.EXE" C:/Users/u/.local/bin/hermes-aify --aify-agent a' }],
  [12, { pid: 12, commandLine: `${process.execPath} ${process.argv[1]} ${marker} ${log}` }],
  [13, { pid: 13, commandLine: "node C:/w/bin/aify-hermes-pending-config.mjs apply --marker C:/h/.aify/hermes-config-pending.json" }],
]);

say("arrive");
const { outcome } = new PendingHermesConfig({ marker }).apply({
  scan: () => WAITING,
  step: () => {
    say("begin");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
    say("end");
    return { ok: true, detail: "" };
  },
});
say(`launch-${outcome}`);
