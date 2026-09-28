// The `herdr pane report-agent` calls a stub herdr recorded, with each call's --seq checked and removed.
//
// Herdr keeps the report with the highest seq and drops one with none once a seq'd report has landed
// (0.9.1), so every aify report must carry one. The seq is a clock reading, so the tests compare the rest.

import assert from "node:assert/strict";

/** Report lines from a stub's call log, each asserted to end in a numeric --seq, returned without it. */
export function reportLines(log) {
  return String(log).split("\n").filter((line) => line.startsWith("pane report-agent")).map((line) => {
    assert.match(line, / --seq [0-9]{16}$/, `a report went out without a microsecond seq: ${line}`);
    return line.replace(/ --seq [0-9]+$/, "");
  });
}
