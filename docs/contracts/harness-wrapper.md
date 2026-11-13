# Harness wrapper contract

**Current implementation contract.** This is the launcher's interface, not a runtime inventory or a promise that
an unobserved client capability works. A host starts a rendered launcher with an argv, environment and actual
working directory; the launcher resolves its inputs, admits a start, composes runtime-specific configuration and
starts that runtime. The platform owns launcher mechanics; services own their bridge/tool and delivery behavior.

The [2026-08-19 aify-comms spec](https://github.com/zimdin12/aify-comms/blob/main/docs/superpowers/specs/2026-08-19-harness-wrapper-contract.md)
is **historical design**, not today's implementation. In particular, its mandatory identity/MCP-command,
install-only configuration and deferred-Hermes statements are not current requirements.

## Host inputs and precedence

| Input | Current behavior |
| --- | --- |
| `HARNESS_ENDPOINT` | Coordinating service URL; legacy `AIFY_COMMS_URL`, then rendered endpoint are fallbacks. Explicit empty is invalid, not an unset value. |
| `HARNESS_IDENTITY` | Optional agent id; legacy `AIFY_AGENT_ID`. Named argv wins; anonymous launches remain valid, with runtime-specific warnings about unavailable status/delivery. |
| `HARNESS_ROLE` | Optional role; legacy `AIFY_AGENT_ROLE`. Named argv wins. Where a definition reader exists, a definition supplies defaults below explicit/env choices. |
| `HARNESS_CWD` | Reported cwd hint; legacy `AIFY_AGENT_CWD`. It does **not** make the launcher change directory. The host must set the actual process cwd. |
| `HARNESS_MCP_COMMAND` | Optional bridge command, interpreted by Claude's strict-MCP path. Default Claude mode warns rather than applying it; Codex/Hermes/Pi accept and report it as unused. It is not a universal per-client MCP override. |
| `HARNESS_EXTRA_ENV` | Literal `KEY=VALUE` lines exported before runtime launch. Blank/comment/non-pair lines are skipped. `AIFY_` and `HARNESS_` prefixes in any case are refused with caller diagnostics; accepted pairs retain Bash export/error semantics, not shell evaluation of their values. |

Precedence where an input has those sources is argv > `HARNESS_*` > legacy environment > definition default >
built-in/rendered default. This is not a claim that every runtime or field supports every source. Endpoint uses
unset-only fallback; the other optional inputs use their existing empty-as-unset defaults. Neither a free-form
role nor a report of permissions grants authorization.

Named Claude/Codex/Hermes starts read definitions; Pi does not gain a definition reader from this contract.
Definitions, managed revision binding, unsupported instruction fields, explicit Claude model selection and
conversation precedence are documented in [README](../../README.md#the-contract). A definition is read, not
rewritten by default selection. `--aify-ignore-definition` is the explicit bypass of that reader, not auth policy.

## Runtime configuration and exported facts

Claude composes its session MCP entries and, in strict mode, a private temporary MCP configuration. Codex gets
its opted-in session servers as encoded app-server config words; its other servers are client configuration.
Hermes session-server changes are host-wide configuration and defer while a Hermes process uses that config.
Pi's accepted MCP-command input does not imply generic registry injection. See [the registry contract](../REGISTRY.md)
for the per-runtime rules and credential isolation; this page does not extend their capabilities.

Launchers export identity/runtime/role/session-mode facts when applicable; a service's bridge consumes them.
[The existing launch-env agreement](dashboard-launch-env.md) names the consumer fields. Optional identity and
session handles must not be replaced with invented bindings. Explicit resident/managed mode wins over stdin
inference. A nested launch drops another session's identity/context by the inherited-session rule.

Wrapper-selected bypass is reported separately from final native permissions. The unattended defaults are
unchanged; `--safe` is not a guarantee about a runtime's own config or an explicitly forwarded bypass argument.
Codex requires a per-launch app-server capability and a name-only inherited pointer for its TUI/service consumers;
[the Codex authentication contract](codex-app-server-auth.md) names the fields, exposure and qualification limits.
Native TUI attach, resident delivery and installed adoption remain separate from source/stub qualification.

## Check, exits and lifetime

The `--check` block reports and exits before runtime/gateway/shared-host startup, service-resume lookups, the
agent lease and session-configuration publication. It is not an operating-system effects sandbox. A **read-only Node helper**
can read a named definition. Earlier launcher preludes have already run: when `HERDR_ENV=1`, the Herdr claim
helper can create its claim directory/log and attempt a pane claim before check is parsed. This existing behavior
is not changed here; “nothing started” must not be read as a universal no-process/no-write/no-IPC guarantee.
Missing runtime/config/helper conditions keep their existing precedence; Codex's pre-parser missing-runtime127
can precede a later missing-helper78. A missing common helper is reported by check and refuses a real launch
only when extra-env/shared functionality is needed.

| Status | Launcher meaning when its own diagnostic names the cause |
| --- | --- |
| `0` | Check succeeded or runtime exited normally. |
| `69` | Shared host command unavailable. |
| `75` | A start cannot take an already-live agent's lease. |
| `78` | Required configuration/definition/helper cannot be used. |
| `127` | Runtime command not found. |

Runtime exit status is preserved, so a number alone does not prove the launcher produced it. Other startup,
readiness, signal and runtime errors can have their own status; this table does not relabel every nonzero exit.

The existing lease admits one live instance per named agent on a host; anonymous/shared preliminary starts do
not acquire another instance. `--shared` reruns the same launcher in the owning host with filtered original
argv, not a separately reconstructed runtime command. It drops only an inferred mode and retains explicit
choices. Runtime-specific cleanup remains at callers: Claude removes temporary files; Codex stops its children;
Hermes/Pi do not acquire invented cleanup. The sourced launcher-common helper has a compatible positional v1 API.

## Render and registry-pair ownership

The installer owns its choices; the renderer validates before target/record publication. External installers may
copy `render.sh` alone beside a template. It must not need a Node category-enumeration call or sibling helper.
The single literal `NAME CATEGORY` block inside that renderer defines these distinct categories:

- `recomputed`: rebuilt from the current registry; required fields must be present in a successful installer
  reader result, even if their value is legitimately empty. Inherited values cannot repair omitted results.
- `client-specific`: rebuilt for that runtime. Codex's extra validation is performed only for a Codex install,
  never to refuse another runtime's otherwise-valid registry.
- `service-override`: a declared service value wins, otherwise the installer's recorded choice remains. Transport
  therefore stays in the render record and does not disappear when the service declares no transport.

Common/client-derived pairs are omitted from records and recomputed on rerender; overrides retain the recorded
fallback. Both strict category readers validate the same marked block. CLI output and NUL record format remain
compatible. Existing public `registry-cli.mjs` verbs are not private just because this installer's path uses fewer
of them; comms' pinned installer also consumes fragments/fingerprint.

Template/registry provenance and strict stale/unknown behavior are specified by
[launcher staleness](launcher-staleness.md), not by version equality alone. Version/provenance is not native
capability proof. Registry-derived strict/session fragments do not bake live `keyEnv` values through the guarded
registry path; HTTP credentials are resolved into private session files at launch. Direct render callers remain
responsible for their supplied values, and the renderer retains conservative content-based file privacy.

Herdr's plugin manifest has a separately reported version. Its external loader/version-ordering contract has not
been verified here, so the manifest value is retained rather than silently rewritten to the npm package version.

## Channel policy readiness before connect

`channelPolicyReadiness({clients, platform, uid, env, read})` is exported from `lib/channel-install.mjs`.
Pass the selected client names and the original install user's environment, including HOME/USERPROFILE; omitted
platform/uid/env use the current process. It uses the existing policy planner, writes nothing, installs no plugin,
invokes no Claude command and performs no elevation. It is a synchronous policy preflight, not the CLI's route `check`.
The result is `{state, command, reason}`. `ready` has `command: null`; selecting no Claude requires no policy read.
`needs-action` is only an absent POSIX policy and supplies one structured command:
`{file: <absolute node>, args: [<absolute channel-install.mjs>, "prepare-policy", "--path", <canonical policy file>], elevate: <uid !== 0>}`.
Only explicit operator consent permits preparation, and only that policy operation may be elevated; never evaluate
an untrusted shell fragment or elevate the whole installer. Preparation must be followed by a fresh readiness read.
`refused` has no command and covers unknown POSIX uid and an existing malformed, unreadable or forbidding policy.
On Windows, a planned per-user merge remains `ready`: the existing install writes it and verifies admission.
That preserves the current Windows success path; readiness does not prove write permission, so the existing
same-account elevated-command refusal may still occur if the later write is denied. Callers must not present this
as a completed install, plugin admission or general root-launch support, and must retain the original user's HOME.

## Changes to this contract

Keep tests at the actual boundary: rendered behavior, both category readers, installer refusal/nonmutation,
record/rerender relationships and actual pinned consumer outputs. A newly described capability needs its own
runtime qualification. Registry fields/header naming and service onboarding are separate from this launcher
contract; existing cross-repo contract paths remain valid until their separately agreed migration.
