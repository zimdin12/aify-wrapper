#!/usr/bin/env node
// The installer asking: is there already an endpoint at this destination?
//
// Thin wiring over lib/installed-endpoint.mjs, matching detect-cli.mjs: the deciding lives in the
// pure module beside it, where the suite reaches the same verdict the installer does.
//
// Prints the endpoint on stdout, or nothing. Exit is always 0 -- "no endpoint installed" is the
// answer on a fresh host, not a failure, and the caller decides what to do about it.

import { endpointInstalledAt } from "./installed-endpoint.mjs";

const found = endpointInstalledAt(process.argv[2] ?? "");
if (found) process.stdout.write(found);
