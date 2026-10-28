// An install recording a hermes config change from its own process, as install.sh does
// (a-hermes-config-change-waits-for-a-quiet-host.test.js).
//
//   node hermes-pending-recorder.mjs <marker> <registry> <config target>

import { PendingHermesConfig } from "../lib/hermes-pending-config.mjs";

const [marker, registry, target] = process.argv.slice(2);
new PendingHermesConfig({ marker }).record(registry, target);
