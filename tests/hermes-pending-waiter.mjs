// A start waiting at the pending change's lock while another holds it (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-waiter.mjs <lock file> <stale ms> <out file>
//
// It waits for the lock as a start would, with the same staleness rule, and logs `contend <ms>` each time its own attempt
// to take the lock finds the lock file there, and `acquired <ms>` once it has it. A `contend` is the witness that it was
// engaged: one that only started after the holder let go never contends. It judges the holder every 100 ms, not every
// two seconds as a start does, so it takes a lock the moment the lock is old enough to take: the strictest waiter.

import fs from "node:fs";

import { FileLock } from "../lib/file-lock.mjs";

const [lock, staleMs, out] = process.argv.slice(2);
const io = {
  ...fs,
  writeFileSync(file, data, options) {
    try {
      return fs.writeFileSync(file, data, options);
    } catch (error) {
      if (error?.code === "EEXIST" && file === lock) fs.appendFileSync(out, `contend ${Date.now()}\n`);
      throw error;
    }
  },
};
new FileLock({ path: lock, waitMs: 30_000, staleMs: Number(staleMs), rejudgeMs: 100, io }).hold(() => fs.appendFileSync(out, `acquired ${Date.now()}\n`));
