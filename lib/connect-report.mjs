// connect's outcome as DATA, for a program that acts on it (aify-env's guided-install chain).
//
// The printed report is prose a service's spec can shape: a pending artifact's reason may hold a newline, and is printed
// as given, so a line that reads like "<id>: installed at <dir>" proves nothing. This record is built from the report
// object itself, so it lists exactly the packages this connect installed or reused, where it put each one.

import fs from "node:fs";

/** The fields a caller may act on: the outcome, the service, and each package installed this run, by id and directory. */
export function connectRecord(report) {
  return {
    result: report.result,
    service: report.service,
    installed: (report.installed ?? []).map(({ id, at, reused }) => ({ id, at, reused: Boolean(reused) })),
  };
}

/** Write the record to `file`, which must not exist yet (a caller hands over a fresh path in a directory it owns). */
export function writeConnectRecord(file, report) {
  fs.writeFileSync(file, `${JSON.stringify(connectRecord(report))}\n`, { flag: "wx", mode: 0o600 });
}
