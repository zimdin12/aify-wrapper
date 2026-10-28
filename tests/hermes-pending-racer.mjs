// One of several starts racing to apply the same pending hermes config change, as at "restart all"
// (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-racer.mjs <marker> <log> <config target> <go file>
//
// It logs `ready`, waits for the go file so every start is released at once, and calls apply. Its scan sees what a host
// restarting its agents shows: launchers, and node waiting at the lock, and no hermes. It logs `contend` each time its
// own attempt to take the lock finds the lock file there, which is a start inside apply, held off by the holder.
// The holder's step logs `begin`, holds until another start has contended (so the overlap is made, not hoped for: a
// loaded host once ran the four one after another), and logs `end`. It logs `launch-<outcome>` only after apply
// returns, where a launcher starts its hermes.

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
/** Whether another start has contended since this one began its step. */
const contendedSince = (offset) => fs.readFileSync(log, "utf8").slice(offset).split("\n")
  .some((line) => line.startsWith("contend ") && line !== `contend ${process.pid}`);
// Every attempt is logged, not only the first: a start whose first attempt fell before the holder's `begin` still
// witnesses the overlap on a later one. FileLock retries every 100 ms and the holder ends as soon as it sees one.
const io = {
  ...fs,
  writeFileSync(file, data, options) {
    try {
      return fs.writeFileSync(file, data, options);
    } catch (error) {
      if (error?.code === "EEXIST" && file === `${marker}.lock`) say("contend");
      throw error;
    }
  },
};
const WAITING = new Map([
  [11, { pid: 11, image: "bash", argv: ["C:\\Program Files\\Git\\usr\\bin\\bash.EXE", "C:/Users/u/.local/bin/hermes-aify", "--aify-agent", "a"] }],
  [12, { pid: 12, image: "node", argv: [process.execPath, process.argv[1], marker, log, target, go] }],
  [13, { pid: 13, image: "node", argv: ["node", "C:/w/bin/aify-hermes-pending-config.mjs", "apply", "--marker", "C:/h/.aify/hermes-config-pending.json"] }],
]);

say("ready");
waitFor(() => fs.existsSync(go), 60_000);
const { outcome } = new PendingHermesConfig({ marker, lock: { io } }).apply({
  scan: () => WAITING,
  step: () => {
    say("begin");
    const offset = fs.statSync(log).size;
    waitFor(() => contendedSince(offset), 30_000);
    say("end");
    return { ok: true, detail: "" };
  },
  target,
});
say(`launch-${outcome}`);
