// One of several starts racing to apply the same pending hermes config change, as at "restart all"
// (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-racer.mjs <marker> <log> <config target> <go file>
//
// It logs `ready`, waits for the go file so every start is released at once, and logs `arrive`. Its scan sees what a
// host restarting its agents shows: launchers, and node waiting at the lock, and no hermes. Its step logs `begin`, holds
// until another start has arrived (so the overlap is made, not hoped for: a loaded host once ran the four one after
// another), and logs `end`. It logs `launch-<outcome>` only after apply returns, where a launcher starts its hermes.

import fs from "node:fs";

import { PendingHermesConfig } from "../lib/hermes-pending-config.mjs";

const [marker, log, target, go] = process.argv.slice(2);
const say = (word) => fs.appendFileSync(log, `${word} ${process.pid}\n`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Wait up to `ms` for `done()`; whether it came. */
const waitFor = (done, ms) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; pause(20)) if (done()) return true;
  return done();
};
const arrived = () => fs.readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("arrive ")).length;
const WAITING = new Map([
  [11, { pid: 11, image: "bash", argv: ["C:\\Program Files\\Git\\usr\\bin\\bash.EXE", "C:/Users/u/.local/bin/hermes-aify", "--aify-agent", "a"] }],
  [12, { pid: 12, image: "node", argv: [process.execPath, process.argv[1], marker, log, target, go] }],
  [13, { pid: 13, image: "node", argv: ["node", "C:/w/bin/aify-hermes-pending-config.mjs", "apply", "--marker", "C:/h/.aify/hermes-config-pending.json"] }],
]);

say("ready");
waitFor(() => fs.existsSync(go), 60_000);
say("arrive");
const { outcome } = new PendingHermesConfig({ marker }).apply({
  scan: () => WAITING,
  step: () => {
    say("begin");
    waitFor(() => arrived() >= 2, 30_000);
    pause(300);
    say("end");
    return { ok: true, detail: "" };
  },
  target,
});
say(`launch-${outcome}`);
