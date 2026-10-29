// A start waiting at the pending change's lock while another holds it (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-waiter.mjs <lock file> <stale ms> <out file>
//
// It writes `waiting` once it is about to ask for the lock, then waits for it as a start would, with the same staleness
// rule, and writes the moment it got it. It judges the holder every 100 ms, not every two seconds as a start does, so it
// takes a lock the moment the lock is old enough to take: the strictest waiter.

import fs from "node:fs";

import { FileLock } from "../lib/file-lock.mjs";

const [lock, staleMs, out] = process.argv.slice(2);
fs.writeFileSync(out, "waiting\n");
new FileLock({ path: lock, waitMs: 30_000, staleMs: Number(staleMs), rejudgeMs: 100 }).hold(() => fs.appendFileSync(out, `acquired ${Date.now()}\n`));
