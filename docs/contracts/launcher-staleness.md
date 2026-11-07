# Launcher staleness

`aify-wrapper-check` reads launcher files; it never executes or sources them. `--strict` exits1 for
stale, unknown or refused judgments, including missing provenance. Without `--strict`, the report's
`ok` carries that verdict and the diagnostic command preserves its existing exit behavior.

## Provenance

The self-contained renderer generates `HARNESS_TEMPLATE_NAME`, `HARNESS_TEMPLATE_SHA256` and
`HARNESS_TEMPLATE_OWNER_ROOT` after validating caller inputs. `HARNESS_TEMPLATE_*` is reserved, not a
caller-supplied render pair. Name and native owner root are Bash-quoted literal words; ordinary package
template names are bare safe words. The owner root records the supplied helper path in native form
(`cygpath -m` when available), without changing the launcher's own helper assignment. SHA256 hashes
the actual template bytes, including template-only comments. If no SHA256 tool can answer, rendering still succeeds
with SHA `unavailable`; this is not positive source evidence.

A valid generated template digest is compared with that template in the launcher's baked helper
package (`AIFY_WRAPPER_DIR_FWD`), not the newer checker package found on PATH. A usable digest wins
over a package-version-only change. An explicitly unreadable or unresolvable owner remains unknown;
launcher metadata is read as restricted literal data, never evaluated.

Without usable generated provenance, a known baked version differing from the owner's VERSION is
stale; otherwise the launcher is unknown, even when versions agree. Version equality alone is never
current. Existing render records contain no output digest and can survive a later unrecorded render;
they cannot turn an unmarked launcher current. Generated metadata records the producer's source;
it is not a signature over arbitrary later file edits. Records are located by normalized native TARGET,
not their filename. Aliases follow their primary record/launcher and must still be byte-equal to it.

For legacy/unavailable provenance the remedy identifies the owning installer/package and asks it to
stamp provenance. Updating a global checker or restarting an agent cannot do that. An older pinned
producer may need upgrading before its next install can supply a marker. This is an honest unknown,
not a reason to compare its launchers against another package tree.

## JSON compatibility

The command retains `ok`, `summary`, `current`, `stale` and `unknown`. Each row retains `name` and
registry `installed`/`expected` fingerprints (or null); template/version values never replace those
registry fields. Additive `reasons` identify their `source`, `state`, `installed`, `expected`, `detail`
and, when known, `ownerRoot`/`remedy`. Known disagreement is stale; absent evidence is unknown;
current requires all checks the command performs to agree. Registry disagreement remains visible
when code provenance is also unavailable.

`hermesConfigPending` keeps its existing name/meaning/shape: null, pending
`{recordedAt, registry, target}`, or unreadable `{problem}`. This is the documented dashboard-facing
contract. Neither current nor unknown is a per-launch MCP/capability guarantee.

The pure `stalenessOf` library keeps its legacy registry-only input contract when no provenance map
is supplied. The command supplies provenance for every launcher; a missing entry in an explicitly
supplied map is unknown, never permission to fall back to a registry-only green.
