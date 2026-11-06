# WSL turn-start facts

The turn-start publisher may add optional root `wsl` metadata to its existing service request:

```json
{"wsl":{"distroId":"0f3c9a7e5b2d4c6e8a1b3d5f7e9c2a4b","driveMounts":[{"mountPoint":"/mnt/c","drive":"C"}]}}
```

## Publisher boundary

Only native Linux may publish the block. Windows and other platforms omit the key, even if supplied
Microsoft-looking proc contents. Linux additionally requires `/proc/sys/kernel/osrelease` contents
matching `/microsoft/i`. Environment variables, `/proc/version` existence and conventional mount
names prove nothing. The existing machine-id rule and total 1500 ms turn-start deadline are unchanged.
Unreadable inputs narrow evidence; they do not throw into the runtime or extend the deadline.

The behavioral authority is aify-dashboard's `server/src/bridge/wsl-facts.ts:collectWslFacts` and
`server/src/locations/wsl.ts:parseProcMounts`. Production wrapper uses a JS twin, not a TypeScript
import, new cache, registry field or lookup API. The dashboard collector has no platform argument:
collector equality applies to Linux specimens; the publisher's platform gate is tested separately.

## Exact facts

- `/etc/machine-id` is trimmed. Missing, unreadable or blank means `distroId: null`, not an invented id.
- Unreadable `/proc/mounts` means no mounts. A line needs at least four fields, type `9p` or `drvfs`,
  options containing `aname=drvfs`, and a declared root `path=X:\` ending at a separator/end.
- Drive letters are upper-cased. Mount points decode only the kernel escapes `\040`, `\011`,
  `\012` and `\134`. Valid entries retain file order; malformed/non-drive entries are dropped,
  never repaired. No `/mnt/c` inference.
- Admitted WSL with no identity or mounts still emits `{ "distroId": null, "driveMounts": [] }`.
  Dashboard's existing registration parser intentionally reduces that to null; the turn succeeds
  with `projectId: null`, rather than inventing placement or refusing the request.
- A blank identity with a valid drive mount is not empty evidence. Escaped and nonstandard mount
  points must survive to actual receiver project placement, not merely equal collector JSON.

## Contract gate and evidence ceiling

`wsl-facts.test.js` drives literal expected specimens through both real collectors and dashboard's
actual `routes/register.ts:wslFacts` parser. `wsl-turn-start.test.js` drives the real wrapper entry
into a private HTTP receiver using the dashboard's production app/router and an owned SQLite store.
It checks omission, exact bodies, empty-evidence success, and standard/escaped mount placement.
The Windows planted-Microsoft case is a load-bearing platform-guard deletion control.

The dashboard source checkout is a mandatory test prerequisite (`AIFY_DASHBOARD_REPO`); missing or
unreadable source/runtime is loudly NOT_RUN, never a passing skip or substitute parser. Run receipts
record the compared dashboard commit and source hashes before/after. Homes, data, credentials and
proc specimens are fixture-owned. No dashboard source or deployed service is changed by the gate.

These are fixture/native-node integration tests, not proof from a live WSL agent. Installed receiver
and publisher deployment are separate; an older receiver may ignore the optional field. The extra
metadata follows the existing generic envelope to opted-in turn-start services, without qualifying
unknown third-party strict schemas.
