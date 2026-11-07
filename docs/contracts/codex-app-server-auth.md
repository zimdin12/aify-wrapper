# Codex app-server authentication

This is the wrapper's capability contract. Adoption also needs the coordinating service's environment-name
allowlist to admit both names below. Publishing wrapper source alone does not qualify a maintained installation
or authorize switching its pin.

## One launch, one capability

`codex-aify` supplies 32 random bytes to the pure `codexAuthMaterial` function. Its unpadded base64url token is
`T`; its server verifier is `D = SHA256(UTF8(T))`, not the hash of the original random bytes.

| Boundary | Value |
| --- | --- |
| Inherited `AIFY_CODEX_APP_SERVER_TOKEN` | Raw `T`, newly minted even when a caller supplied an old value. |
| Inherited `AIFY_CODEX_REMOTE_AUTH_TOKEN_ENV` | The literal name `AIFY_CODEX_APP_SERVER_TOKEN`, not `T`. |
| Both app-server launch branches | `--ws-auth capability-token --ws-token-sha256 D`. |
| Fresh and resume TUI | `--remote-auth-token-env AIFY_CODEX_APP_SERVER_TOKEN`. |
| Service runtime configuration | `remoteAuthTokenEnv` carries the variable name only. The service must retain access to its inherited value. |

The wrapper suppresses xtrace around capture/assignment, restores the caller's trace setting afterwards, and
uses no token file. It does not put `T` in its runtime argv or registration configuration. The verifier stays
shell material rather than another inherited variable. Missing helpers, failed minting and malformed private
output refuse before app-server/TUI startup. The package installer requires the helper before replacing an
installed Codex launcher; render-only callers retain responsibility for the package they name.

## Readiness, refusal and handoff

The flag set is qualified against codex-cli 0.166.0. There is no per-launch help/version probe or unauthenticated
retry. The single Node TCP waiter retains its ten-second bound. The owning Bash checks its app-server job
between private waiter events; it does not cache a Windows native PID across an MSYS exec or start a process
per polling iteration. POSIX Node also retains its direct process query. The waiter is closed and reaped before
readiness returns.

An exact `error: unexpected argument '<auth-flag>' found` line in the startup log tail for a supplied server
auth flag produces the wrapper's sanitized unsupported-auth diagnostic and status78. Other server-start failures retain the existing
reachability diagnostic/status1; a generic error merely mentioning a flag is not evidence of unsupported auth.
A TUI flag rejection remains visible with its native status. `--check` reports required auth without minting or
probing runtime support; the general contract's existing pre-check effects still apply.

A shared preliminary launch stops its children and discards its capability, pointer and verifier before host
handoff. The host-side launcher then mints its own material; it does not reuse the discarded capability.

## Exposure and qualification limits

App-server descendants, including agent shell tools, may inherit `T`. Exclusion of TOKEN-named variables by a
runtime is **ASSUMED**, not relied upon. This is not a boundary against the agent itself or another same-user
process able to inspect environments. Native runtime logging or deliberate disclosure by a descendant is not
controlled by the wrapper's argv/xtrace safeguards.

**PROVEN, scoped to Windows codex-cli0.166.0:** the native server rejected missing/wrong tokens with401 and
accepted the correct token through maintained RPC initialization. That probe's initial cleanup assertion failed;
subsequent OS closure was observed separately. **PASSES IN TESTS:** rendered launchers with owned executable
stubs cover both branches, fresh/resume propagation, host reminting, name-only registration composition and
bounded cleanup. Native TUI attach, resident dispatch, other platforms and a newly pinned installation are not
established by those tests. The service's secret/pointer allowlist remains an adoption prerequisite.
