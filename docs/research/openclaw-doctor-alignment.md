# OpenClaw doctor alignment

Research date: 2026-11-14.

OpenClaw source read from a local clone of `openclaw/openclaw` `main` at `5ee546414080d79fed4613bc89cc34bfa4deb06e` (2026-11-14, "improve: make the command palette bottom bar compact and quieter"). Package exercised: npm `openclaw@2026.11.3` (`OpenClaw 2026.11.3 (847611d)`), installed under Node 24.16.0 because that release refuses Node 22 (`package.json` engines: `>=24.16.0 <25 || >=26.1.0`). Lint was run with an isolated `HOME` and `OPENCLAW_STATE_DIR`. Paths below are that clone unless marked ClawFix.

ClawFix should keep owning probes Doctor does not make (dead listener, foreign process on the gateway port, install layout). It should stop re-deriving facts Doctor already returns as a stable check id.

## Command entry

`registerMaintenanceCommands` registers `doctor` in `src/cli/program/register.maintenance.ts:35-301`.

The action (`:108-301`) rejects mixed operations before it imports a handler:

- `--lint` cannot combine with `--repair`, `--fix`, `--force`, `--yes`, `--generate-gateway-token`, or `--session-sqlite` (`:164-178`). The error says lint is read-only.
- `--lint`, `--post-upgrade`, `--state-sqlite`, `--session-sqlite`, and repair/token generation are mutually exclusive (`:188-205`).
- `--severity-min`, `--all`, `--skip`, and `--only` require `--lint` (`:206-217`). Bare `--json` does not accept them.
- `--replace-model` requires `--fix` or `--repair` (`:218-222`).

Dispatch:

- `--client-credentials` (only with `--repair`/`--fix`, `--non-interactive`, and optionally `--json`) calls `prepareStartupClientCredentials` and does not run health checks (`:230-242`).
- `--lint`, or bare `--json` when no other operation is set, calls `runDoctorLintCli` (`:152-163`, `:243-254`). Bare `--json` then forces exit code 0 after the report (`:254`). Explicit `--lint` keeps the findings exit code.
- Unsupported Node also forces the lint path (`:159-163`), so a plain `doctor` on a too-old Node does not repair.
- Every other mode calls `doctorCommand` in `src/commands/doctor.ts:48-186`, which branches to state-sqlite compact, session-sqlite, post-upgrade probes, or `runDoctorHealthFlow` (`src/flows/doctor-health.ts:49`).

`runDoctorLintCli` (`src/commands/doctor-lint.ts:6-22`) prepares a Postgres pool labeled `openclaw doctor --fix` even for lint, then runs in-process lint unless an update rehearsal with `--json` delegates to a worker that inherits the update budget.

## Flags

Defined at `src/cli/program/register.maintenance.ts:43-107`:

| Flag | Effect |
|---|---|
| `--no-workspace-suggestions` | Commander default `workspaceSuggestions: true`. Passed only into `doctorCommand` (`:263`), not into `runDoctorLintCli` (`:245-253`). On the lint path the flag is accepted and ignored. |
| `--yes` | Accept defaults. Repair-side. Illegal with `--lint`. |
| `--repair` / `--fix` | Apply repairs. `--fix` is an alias (`:46`). |
| `--force` | Aggressive repair choices; with `--fix`, preserves service definitions (`:47-50`). |
| `--non-interactive` | No prompts; safe migrations only (`:52`). |
| `--client-credentials` | Prepare local client credentials. Requires repair plus `--non-interactive` (`:53-57`, `:122-139`). |
| `--generate-gateway-token` | Generate and configure a gateway token (`:58`). Illegal with `--lint`. |
| `--allow-exec` | Resolve exec SecretRefs while verifying secrets (`:59-62`). Forwarded to lint (`:251`). |
| `--replace-model <json>` | Repeatable `{from,to,accessProgram}` mapping. Requires `--fix`/`--repair` (`:64-69`, `:218-229`). |
| `--deep` | Scan system services for extra gateway installs (`:70`). Forwarded to lint (`:252`). |
| `--full-integrity-check` | Full database integrity during migrations (`:71`). Repair path only. |
| `--lint` | Read-only health checks (`:72`). |
| `--post-upgrade` | Plugin-compat findings only (`:73-77`). Not lint. |
| `--session-sqlite <mode>` | `dry-run\|import\|validate\|inspect\|compact\|restore\|recover` (`:78-81`). |
| `--state-sqlite <mode>` | Shared-state SQLite maintenance. Only `compact` is parsed later. Combinable only with `--json` (`:17`, `:82`, `:113-120`). |
| `--json` | Machine-readable output. Alone, it runs the same default checks as lint and then exits 0 (`:95`, `:152-163`, `:254`). |
| `--severity-min <level>` | `info`, `warning`, or `error` (`:96-99`). Default when omitted is `warning` (`src/commands/doctor-lint-runner.ts:163-167`). Filters printed findings and the exit threshold (`src/flows/doctor-lint-flow.ts:194-199`). |
| `--all` | Include checks with `defaultEnabled: false` (`:100`, `src/flows/health-checks.ts:112-115`, `src/flows/doctor-lint-flow.ts:112-120`). |
| `--skip <id>` | Repeatable. Drops that id after `--only` filtering (`:101`, `src/flows/doctor-lint-flow.ts:114-122`). |
| `--only <id>` | Repeatable. Unknown ids emit `core/doctor/lint-selection` and still run any known ids (`:102-107`, `src/flows/doctor-lint-flow.ts:124-140`). |

Documented exit codes for explicit lint (`docs/cli/doctor/lint.md:112-116`, matching `src/cli/program/register.maintenance.ts:289-298` and `src/flows/doctor-lint-flow.ts:194-199`):

| Code | Meaning |
|---|---|
| 0 | No finding at or above `--severity-min` (default `warning`). |
| 1 | At least one finding meets the threshold. |
| 2 | Command or runtime failure before checks complete. JSON is one document with `status: "blocked"`, `ok: false`, `checksRun: 0`, and a single `core/doctor/lint-inspection` error. `error.type` stays `cli_error`. |

Captured on `openclaw@2026.11.3`: `doctor --lint --json --severity-min bogus` exited 2 and printed that envelope. `doctor --lint --json --only core/doctor/does-not-exist` exited 1 with `checksRun: 0`, `checksSkipped: 70`, and one `core/doctor/lint-selection` error whose `path` is the unknown id.

## Check registry

Process-local `Map` in `src/flows/health-check-registry.ts:4-19`. Duplicate ids throw `OC_DOCTOR_DUPLICATE_CHECK`. Insertion order is the lint order (`:21-24`).

Core checks are not registered through that map for the lint command. `resolveDoctorContributionHealthChecks` (`src/flows/doctor-health-contributions.ts:444-476`) walks contributions in `src/flows/doctor-health-contributions-initial.ts` and `src/flows/doctor-health-contributions-final.ts`, loads `createCoreHealthChecks()` (`src/flows/doctor-core-checks.ts:621-719`), and stamps each check with the contribution's `updateWork`.

`prepareDoctorLintExecution` (`src/commands/doctor-lint-runner.ts:469-523`) builds the lint list as:

1. `stateSchemaHealthCheck` (`src/flows/doctor-lint-flow.ts:18-87`), always first.
2. Core contribution checks, with a few wrapped so they read a private snapshot or the source env (`:471-512`).
3. Extension checks from `listExtensionHealthChecksForDoctor` (`src/flows/health-check-registry.ts:27-58`). An extension id starting with `core/doctor/` throws.

Bundled plugins register through `registerBundledHealthChecks` (`src/flows/bundled-health-checks.ts:125-186`): memory-core (tagged `updateReadiness: "post-plugin"`), Codex, policy, OpenAI, Cua, skill-workshop, and bundled worker providers.

`runDoctorLintChecks` (`src/flows/doctor-lint-flow.ts:104-169`) runs `detect` only. A thrown check becomes a finding on that check id (`severity: "error"`, or `info` with `errorCode: OPENCLAW_STATE_LEASE_ABORTED` when the caller aborted a state lease). Findings sort by severity desc, then `checkId`, then `path` (`:181-192`).

`repair()` exists on the `HealthCheck` contract (`src/flows/health-checks.ts:100-110`) and runs only under `doctor --fix` / `--repair`. Lint never calls it. Contributions that only implement `run()` are invisible to `--lint` (`docs/cli/doctor/health-contract.md:30`).

### Check ids

Observed registry size on 2026.11.3: 70 checks (`checksSkipped: 70` when `--only` names an unknown id). A default lint run executed 40 and skipped 30.

Default-on core ids (no `defaultEnabled: false` on the check object):

| Id | Where |
|---|---|
| `core/doctor/state-schema` | `src/flows/doctor-lint-flow.ts:18` |
| `core/doctor/agent-deletion-journal` | emitted by the state-schema detect, `:56` |
| `core/doctor/gateway-config` | `src/flows/doctor-core-checks.ts:53` |
| `core/doctor/command-owner` | `:87` |
| `core/doctor/gateway-auth` | `:110` |
| `core/doctor/hooks-model` | `:116` |
| `core/doctor/claude-cli` | `:261` |
| `core/doctor/oauth-tls` | `:275` |
| `core/doctor/stale-runtime-build` | `:327` |
| `core/doctor/codex-session-routes` | `:47`, `:337` |
| `core/doctor/telegram-general-topic-conversations` | `:50`, `:375` |
| `core/doctor/gateway-services/platform-notes` | `:422` |
| `core/doctor/node-runtime` | `:443` |
| `core/doctor/browser` | `:453` |
| `core/doctor/shell-completion` | `:566` |
| `core/doctor/ui-protocol-freshness` | `:577` |
| `core/doctor/runtime-capabilities` | `:661` (severity `info`; hidden at the default threshold) |
| `core/doctor/security` | `:677` |
| `core/doctor/provider-catalog-projection` | `:694` |
| `core/doctor/local-audio-acceleration` | `:703` |
| `core/doctor/cron-inference-accounts` | `src/flows/doctor-cron-checks.ts:19` |
| `core/doctor/model-references` | `src/flows/doctor-model-reference-check.ts:8` |
| `core/doctor/runtime-tool-schemas` | `src/flows/doctor-tool-schema-check.ts:5` |
| `core/doctor/bootstrap-size` | `src/flows/doctor-core-bootstrap-size-check.ts:6` |
| `core/doctor/acp-agent-model` | `src/flows/doctor-acp-agent-model-check.ts:8` |
| `core/doctor/final-config-validation` | `src/flows/doctor-config-validation-findings.ts:10` |
| `core/doctor/native-status` | `src/flows/doctor-native-status-check.ts:4` |
| `core/doctor/appcontainer-spawn` | `src/flows/doctor-native-status-check.ts:64` |
| `core/doctor/gateway-services/extra` | `src/flows/doctor-gateway-services-check.ts:10` |
| `core/doctor/legacy-output-cap` | `src/flows/doctor-legacy-output-cap-check.ts:8` |
| `core/doctor/gmail-gog` | `src/flows/doctor-gmail-gog-check.ts:7` |
| `core/doctor/removed-workspaces-state` | `src/flows/doctor-removed-workspaces-state-check.ts:12` |
| `core/doctor/session-archive-read-cache` | `src/flows/doctor-session-archive-cache-check.ts:7` |
| `core/doctor/sandbox/registry-files` | `src/commands/doctor-sandbox.ts:33`, registered at `src/flows/doctor-health-contributions-initial.ts:616` |
| `core/doctor/channel-package-state-capabilities` | `src/flows/doctor-health-contributions-final.ts:80`, `:144` |
| `core/doctor/workspace-alias` | `src/commands/doctor-workspace-alias.ts:45` |
| `core/doctor/memory-provenance` | `src/commands/doctor-memory-provenance.ts:13` |
| `core/doctor/heartbeat-cadence-migration` | `src/commands/doctor-heartbeat-cadence-migration.ts:58` |
| `core/doctor/heartbeat-scratch-migration` | scratch contribution, `src/flows/doctor-health-contributions-final.ts:417` |
| `core/doctor/heartbeat-task-cron-migration` | `:452` |
| `core/doctor/tools-md-migration` | `:433` |
| `core/doctor/node-hosting-preconditions` | `src/commands/doctor-node-hosting-preconditions.ts:19` |
| `core/doctor/agent-database-admission` | `src/flows/doctor-health-contributions-initial.ts:72` |
| `core/doctor/database-engine` | contribution detect, `:107` |
| `core/doctor/update-snapshots` | `src/commands/doctor-update-snapshots.ts:17` |

Opt-in (`defaultEnabled: false`; omitted unless `--all` or `--only`):

`core/doctor/legacy-state` (`src/flows/doctor-core-checks.ts:145`), `core/doctor/legacy-whatsapp-crontab` (`:304`), `core/doctor/legacy-cron-store` (`src/flows/doctor-cron-checks.ts:8`), `core/doctor/skills-readiness` (`src/flows/doctor-core-checks.ts:502`), `core/doctor/workspace-suggestions` (`:589`), `core/doctor/gateway-health` (`:640`), `core/doctor/gateway-daemon` (`:651`), `core/doctor/auth-profiles` (`src/flows/doctor-health-contributions-initial.ts:126`), `core/doctor/session-transcripts` (`:190`), `core/doctor/legacy-plugin-manifests` (`:216`), `core/doctor/legacy-plugin-dependencies` (`:240`), stale plugin-runtime symlinks (`:261`), `core/doctor/configured-plugin-installs` (`:278`), `core/doctor/plugin-registry` (`:335`), `core/doctor/disk-space` (`:427`), `core/doctor/project-clone-shape` (`:442`), `core/doctor/state-integrity` (`:477`), `core/doctor/session-snapshots` (`:558`), `core/doctor/config-audit-scrub` (`:581`), host desktop (`src/flows/doctor-health-contributions-final.ts:106`), `core/doctor/default-account-routing` (`:118`), `core/doctor/channel-plugin-blockers` (`:171`), `core/doctor/channel-preview-warnings` (`:185`), systemd linger (`:278`), `core/doctor/workspace-status` (`:286`), `core/doctor/whatsapp-responsiveness` (`:484`), memory search (`:518`), `core/doctor/device-pairing` (`:531`), write-config (`:551`).

Synthetic ids that are not registry members: `core/doctor/lint-inspection` and `core/doctor/lint-state-inspection` (`src/commands/doctor-lint-output.ts:63`, `:134`), `core/doctor/lint-selection` (`src/flows/doctor-lint-flow.ts:135`).

Extension ids seen in tree: `memory-core/managed-local-embedding-setup` (`extensions/memory-core/src/doctor-health.ts:179`), `codex/managed-app-server` (`extensions/codex/src/doctor.ts:13`), `skill-workshop/tool-policy` (`extensions/skill-workshop/doctor-health-api.ts:11`), `crabbox/cloud-worker-profiles`, `crabbox/setup-secrets`, `crabbox/warm-images` (`extensions/crabbox/src/doctor.ts:29-31`).

`core/doctor/security` does not forward `openclaw security audit` check ids. `collectSecurityWarnings` (`src/commands/doctor-security.ts:206-359`) builds its own findings (`doctor.approval_forwarding_disabled`, `doctor.heartbeat_direct_policy_unset`, exec-policy and plaintext-secret warnings, `gateway.bind_no_auth`, `gateway.bind_network_accessible`, channel findings). `securityAuditFindingToHealthFinding` (`src/flows/health-check-adapter.ts:22-32`) then rewrites every one of them to `checkId: "core/doctor/security"` and stores the original id in `requirement`.

`core/doctor/gateway-auth` (`src/flows/doctor-gateway-auth.ts:32-124`) returns nothing when `gateway.mode` is `remote` or when the resolved auth mode is not `token`. Explicit `gateway.auth.mode: "none"` produced no `gateway-auth` finding on 2026.11.3. A missing token in token mode (including an empty `{}` config, which resolves to token mode) returns severity `warning`, path `gateway.auth.token`, no `requirement`, message `Gateway auth is off or missing a token.`, and fix hint `Run \`openclaw doctor --fix --generate-gateway-token\` to generate a token, then restart the Gateway.` (`:107-123`). SecretRef failures are a different finding: warning or error, often with `requirement: SECRET_REF_REDACTED_VALUE`, and a fix hint that does not generate a token (`:84-104`).

## JSON output schema

`schemaVersion` is `1` (`src/commands/doctor-lint-output.ts:15-37`). Success and ordinary lint write one JSON line to stdout via `writeJsonResult` (`:39-48`). Human mode is used only when stdout is a TTY and `--json` was not passed (`:104-106`).

```json
{
  "schemaVersion": 1,
  "ok": true,
  "checksRun": 0,
  "checksSkipped": 0,
  "findings": [],
  "databaseStores": [],
  "recoveryCopies": {},
  "warnings": []
}
```

`databaseStores` is present only when a `core/doctor/database-engine` finding carried `details` (`src/commands/doctor-lint-runner.ts:555-557`, `:578-586`). `recoveryCopies` is read-only disk usage. `warnings` is omitted when empty (`doctor-lint-output.ts:35`). On a normal lint it holds findings below `--severity-min` only when `errorCode` is `OPENCLAW_STATE_LEASE_ABORTED`, plus settled cleanup warnings (`doctor-lint-runner.ts:559-564`). Update-doctor lint also parks advisory warnings there and downgrades advisory errors to warnings (`:548-553`).

Each finding (`doctor-lint-output.ts:74-89`, contract in `src/flows/health-checks.ts:30-48`):

| Field | In JSON? |
|---|---|
| `checkId`, `severity` (`info`\|`warning`\|`error`), `message` | always |
| `source`, `errorCode`, `path`, `line`, `column`, `ocPath`, `target`, `requirement`, `fixHint`, `details` | when set |
| `category` (`fix-now`\|`recommended`\|`historical`), `docsUrl` | on the in-memory finding (`health-checks.ts:33-36`) but omitted by `toJsonFinding` |

The failure document (`doctor-lint-output.ts:51-71`) spreads `formatCliJsonFailure` (`src/cli/failure-output.ts:65-78`: `ok: false`, `error.type: "cli_error"`, `error.message`) and then the lint envelope with `status: "blocked"`.

Empty `{}` config, same argv ClawFix uses, exited 1 with `checksRun: 40`, `checksSkipped: 30`, and four warnings: `core/doctor/gateway-auth`, `core/doctor/gateway-config`, `core/doctor/heartbeat-cadence-migration` (`requirement: heartbeat-monitor-create`, `target: main`), `core/doctor/node-runtime` (`requirement: recommended Node security patches`). `openclaw security audit --json` on that same config returned `gateway.loopback_no_auth` (critical), `gateway.http.no_auth`, `gateway.trusted_proxies_missing`, world-readable config and state dir, and a Node patch warning. Doctor lint did not emit those security-audit ids. The two commands are not substitutes.

## Skip lists

There is no built-in skip list. Selection is (`src/flows/doctor-lint-flow.ts:114-122`):

1. If `--only` is non-empty, drop every other id.
2. Otherwise drop `defaultEnabled: false` unless `--all`.
3. Drop ids passed to `--skip`.
4. During an update rehearsal, inspection and standalone checks are added to `skipIds` and replaced with an `update-inspection-deferred` warning (`src/commands/doctor-lint-runner.ts:208-220`, `:515-538`). The budget math is in `src/flows/doctor-update-budget.ts:29-48` and `:141-174`.

ClawFix's own skip is one id: `core/doctor/skills-readiness` (`cli/bin/native-diagnostics.js:172-178`, hosted copy in `src/routes/script.js:858-866`). That check is already `defaultEnabled: false` (`src/flows/doctor-core-checks.ts:502-505`), so the skip is defensive, not what keeps workspace skill scans off the default run. ClawFix also passes `--no-workspace-suggestions`. Lint does not read that flag, and `core/doctor/workspace-suggestions` is already opt-in (`:589-593`).

## Migrations `doctor --fix` performs

`--fix` is not a single config edit. `doctorCommand` enters `runDoctorHealthFlow` (`src/commands/doctor.ts:179-181`, `src/flows/doctor-health.ts:49`). Repair mode stops the managed gateway when needed, takes maintenance ownership, and runs the contribution `run()` handlers, which call `repair()` where a check has one (`docs/cli/doctor/health-contract.md:30-34`). After a successful repair, doctor re-runs `detect` scoped to the repaired findings.

Persistent migrations, from `docs/cli/doctor/state-migrations.md` and `docs/cli/doctor/checks.md`, all owned by this command rather than by gateway startup:

- Legacy state-dir rename `~/.clawdbot` to `~/.openclaw`, and `clawdbot.json` to `openclaw.json`, only when the destination is absent (`state-migrations.md:122-136`). Both directories existing is left for the operator.
- File-to-SQLite imports: workspace setup files, cron jobs and runtime state, session JSON, Telegram ingress spool, Voice Wake and conversation bindings, OAuth sidecars and `credentials/oauth.json`, auth-profile provider renames (`state-migrations.md:83-107`, `:226`, `checks.md:93-118`).
- Session-row field upgrades (pending delivery, model fallback, memory flush) with a verified SQLite backup before rewrite (`state-migrations.md:158-198`).
- Schema upgrades for shared state and agent databases. Lint only reports `core/doctor/state-schema` when the snapshot version is behind (`src/flows/doctor-lint-flow.ts:72-84`). The repair is `--fix`.
- Config migrations: unknown keys dropped on `--fix` (skipped mid-update), legacy `codex/*` and `openai-codex/*` model refs rewritten to `openai/*`, Claude conversation ids moved to provider-keyed bindings, `skill_workshop` tool policy split to `skill_library`, Talk flat config normalized, stale plugin allow/deny/entries removed, invalid plugin entries quarantined (`checks.md:70`, `:102-130`).
- Heartbeat retirement: cadence, scratch `HEARTBEAT.md`, and task blocks become cron automations (`src/flows/doctor-health-contributions-final.ts:82-90`, `:401-474`). The cadence finding's fix hint is `openclaw doctor --fix`, not a config write.
- Gateway token generation when `--generate-gateway-token` is set, and SecretRef store regeneration for a redacted gateway token (`src/flows/doctor-gateway-auth.ts:98-100`).
- Skill readiness repair disables unavailable skills (`src/flows/doctor-core-checks.ts:513`). Updater-driven repair leaves skill enablement alone (`checks.md:135`).
- Official plugin installs and version alignment, sandbox image build for the default Docker image, project-clone unshallow (`checks.md:125-126`, `:140`).
- Service reinstall only for eligible installation drift. Operator systemd drop-ins are not rewritten (`checks.md:85-87`).

Interrupted migrations keep backups and are resumed by rerunning `--fix` (`state-migrations.md:200-224`). A blocked step carries `refusal.code: "blocked-by-prior-refusal"` and `originatingRefusal.stepId`. Pre-June iMessage, Active Memory, Nostr, and Teams JSON, and pre-July Telegram sidecars, are no longer imported; Doctor points at `2026.9.5` (`state-migrations.md:68-79`).

Calling unbounded `openclaw doctor --fix` from ClawFix would run this whole set. ClawFix's current token repair calls the narrower `doctor --fix --generate-gateway-token` only after it has set `gateway.auth.mode` itself (`cli/core/repair-catalog.js:295-357`).

## Timeouts

| Clock | Value | Where |
|---|---|---|
| Hosted Doctor diagnosis process | 120_000 ms, then the process tree is killed | `src/commands/doctor-process.ts:51-56`. Docs: `docs/cli/doctor/lint.md:26-27`. Output cap 1 MiB (`doctor-process.ts:16`, `:100-103`). |
| Published update validation window | 298_000 ms of work, 2 s cleanup, 300 s total | `src/flows/doctor-update-budget.ts:29-43` |
| Command spawn margin subtracted from that window | 10_000 ms | `:42-43` |
| Inspection window for optional update work | half of 298 s, or a fresh half-window when the driver records `candidate-state-snapshot` | `:44`, `:116-137` |
| Fleet admission | 2_000 ms per agent, 5_000 ms per run. This admits or defers; it does not kill | `:45-48`, `:149-157` |
| OpenAI OAuth TLS preflight inside a check | 4_000 ms | `src/flows/doctor-core-checks.ts:286` |
| WhatsApp responsiveness status RPC | 3_000 ms | `src/flows/doctor-health-contributions-final.ts:505` |
| ClawFix lint spawn | 120_000 ms, matching the hosted diagnosis budget | `cli/bin/native-diagnostics.js:6-11`, `src/routes/script.js:826-836` |
| ClawFix `status`, `security audit`, `config validate`, `update status` | 30_000 ms | `cli/bin/native-diagnostics.js:90`, `:407-417` |

A lint kill at 120 s is a collector timeout. Doctor may already have written a partial stdout. That text is not a finished envelope.

## What ClawFix does with the report

CLI: `collectNativeDoctor` (`cli/bin/native-diagnostics.js:171-244`) runs

```text
doctor --lint --json --severity-min warning --skip core/doctor/skills-readiness --no-workspace-suggestions
```

with a 120 s kill and a 1_000_000 byte stdout cap. It accepts exit 0 and 1 only (`:37-39`, `:202`). It keeps `checkId`, `severity` (`info`|`warning`|`error`, else `warning`), `message`, `path`, and `fixHint`. It drops `schemaVersion`, `requirement`, `errorCode`, `source`, `line`, `column`, `ocPath`, `target`, `details`, `warnings`, `databaseStores`, and `recoveryCopies`. Findings are sliced to 100.

The hosted script copies that argv, timeout, exit rule, and field set (`src/routes/script.js:826-930`). `SCRIPT_HASH` is the sha256 of that script.

`deriveIssues` (`cli/core/diagnostics.js:1165-1199`) appends non-info security-audit findings first, then doctor findings whose message does not exactly match an existing title or description and whose `checkId` is not already used. Doctor severity `error` becomes ClawFix `high`; everything else becomes `medium`. Repair authorization is an exact `nativeCheckId` map (`cli/core/findings.js:30-34`): `gateway.loopback_no_auth` and `runtime/gateway-port-conflict` only.

The server `detectIssues` (`src/known-issues.js:1888`) does not read `nativeDoctor`. The hosted payload stores the projected doctor object (`src/routes/script.js:965`) and the pattern matcher never looks at it. CLI uploads derived issues as `_localIssues`, which the server matches only by known-issue id or exact title (`src/known-issues.js:1847-1868`, `src/routes/diagnose.js:142-146`).

## Ranked alignment

Value is operator impact if ClawFix gets this right. Risk is the chance the change mis-repairs a host or hides a real finding. Ranks 1 and 2 are the changes to make first.

| Rank | Bucket | Item | Value | Risk | Evidence |
|---|---|---|---|---|---|
| 1 | (c) | Accept the documented exit-2 lint envelope. Today exit 2 is thrown away even when stdout is the `core/doctor/lint-inspection` report. | High | Low | `docs/cli/doctor/lint.md:159`. `register.maintenance.ts:294-297`. Captured `severity-min bogus` on 2026.11.3 exited 2 with `status: "blocked"` and one lint-inspection finding. ClawFix `cli/bin/native-diagnostics.js:37-39` and `:202-206`, and `src/routes/script.js:885`, keep only status 0 and 1. `test/runtime-regressions.test.js:210-217` locks the rejection in. |
| 2 | (a), (c) | Read `core/doctor/gateway-auth` and `core/doctor/security`'s `requirement` instead of a second auth detector. Keep the existing token repair; do not start running open-ended `--fix`. | High | Low | Empty config on 2026.11.3: doctor finding `core/doctor/gateway-auth` / path `gateway.auth.token` / the generate-token fix hint, and security audit `gateway.loopback_no_auth`, same host. Messages differ, so `diagnostics.js:1186-1190` keeps both. The repair map keys only `gateway.loopback_no_auth` (`findings.js:32-33`). If the audit command fails, the doctor finding stays advisory. SecretRef gateway-auth findings use a different hint and sometimes `requirement: SECRET_REF_REDACTED_VALUE` (`doctor-gateway-auth.ts:84-104`) and must not take the token repair. `securityAuditFindingToHealthFinding` (`health-check-adapter.ts:22-32`) puts the real audit id in `requirement` and the JSON writer keeps it (`doctor-lint-output.ts:86`). ClawFix drops `requirement`. |
| 3 | (a) | When `nativeDoctor` is available, let `core/doctor/heartbeat-cadence-migration`, `heartbeat-scratch-migration`, and `heartbeat-task-cron-migration` replace the server's leftover-key detector `heartbeat-no-model-override`. | High | Medium | Doctor finding on an empty config: `requirement: heartbeat-monitor-create`, fix hint is `openclaw doctor --fix` (`doctor-heartbeat-cadence-migration.ts:476-493`). ClawFix still matches any `agents.defaults.heartbeat` object (`src/known-issues.js:816-830`) and does not read `nativeDoctor`. A key doctor has already migrated, or a shape doctor refuses, can still be flagged from the raw config. Medium risk because a timed-out doctor must not silence the local detector. |
| 4 | (c) | Project `requirement`, `errorCode`, `line`, and `target` through both parsers, and teach the server to surface doctor findings that do not already match a known issue. | High | Medium | Same drop as rank 2, plus `detectIssues` ignoring `openclaw.nativeDoctor` (`src/known-issues.js:1888`, payload at `script.js:965`). Surfacing every warning as a known issue would attach fix scripts; unmapped findings have to stay advisory. |
| 5 | (a) | Treat `core/doctor/final-config-validation` as the config verdict when doctor lint succeeded, and keep `openclaw config validate --json` for the case doctor did not run. | Medium | Medium | Both exist. Doctor id is `src/flows/doctor-config-validation-findings.ts:10`. ClawFix always runs validate (`cli/bin/native-diagnostics.js:247`) and titles the first error itself (`diagnostics.js:1115-1127`). Dedup is exact message text (`:1186-1190`), so a reworded validator line shows up twice. |
| 6 | (c) | Stop passing `--no-workspace-suggestions` on the lint argv. It does not change lint. | Low | Low | Flag is not copied into `runDoctorLintCli` (`register.maintenance.ts:245-253`). The suggestions check is opt-in (`doctor-core-checks.ts:589-593`). |
| 7 | (c) | Read the JSON `warnings` array for `OPENCLAW_STATE_LEASE_ABORTED`. | Low | Low | Those infos mean the check did not run (`doctor-lint-runner.ts:559-564`, `docs/cli/doctor/lint.md:131-135`). Default `--severity-min warning` hides ordinary infos anyway. |
| 8 | (b) | Replace `gateway-loopback-no-auth`'s `config set` plus `doctor --fix --generate-gateway-token` with a single `doctor --fix`. | Medium | High | `--fix` runs the migration set above, can stop the gateway, install plugins, and rewrite models (`docs/cli/doctor/checks.md`). The current repair is bounded (`repair-catalog.js:295-357`). Doctor's own hint for the missing-token shape is the narrower `--generate-gateway-token` form (`doctor-gateway-auth.ts:121-122`), which is still a full `--fix` run plus token generation. |
| 9 | (b) | Delegate `auto-update-enabled-warning` and `no-memory-flush` to doctor. | Low | High | No doctor check owns `update.auto.enabled` or `agents.defaults.compaction.memoryFlush.enabled`. ClawFix's `config set` repairs are the supported write (`repair-catalog.js:230-250`). Heartbeat repairs are already advisory and tell the operator to run doctor (`src/known-issues.js:825-830`, `cli/interfaces/plain.js:301-307`). |
| 10 | (d) | Invalid `session_windows` rows that `sessions.delete` reports as deleted and that no doctor check retires. | High | High to invent a repair | [openclaw#160719](https://github.com/openclaw/openclaw/issues/160719), open. Title states there is no CLI, doctor, or reaper path. ClawFix does not scan session table flags. |
| 11 | (d) | Gateway startup stuck for minutes in model-runtime publication, past both 120 s budgets. | High | Medium to report, high to kill | [openclaw#152981](https://github.com/openclaw/openclaw/issues/152981): about 17 minutes at `sidecars.model-runtime`, then "prepared model runtime publication timed out". Doctor's hosted deadline is 120 s (`doctor-process.ts:56`). ClawFix's lint kill is the same and is reported as a collector timeout, not as this sidecar failure. |
| 12 | (d) | `memory_search` stall at 15 s with no per-call timeout. Doctor's memory-search check is opt-in. | Medium | Medium | [openclaw#136405](https://github.com/openclaw/openclaw/issues/136405). Memory search is `defaultEnabled: false` (`doctor-health-contributions-final.ts:518-522`). ClawFix's memory findings are config advice (`no-memory-flush`, missing memory files), not a hung search call. |
| 13 | (d) | `HEARTBEAT.md` over 256 KiB or not UTF-8 passes template validate and fails later. | Medium | Low to detect size, medium to repair | [openclaw#198848](https://github.com/openclaw/openclaw/issues/198848). Doctor migrates scratch content; it does not report this size limit. ClawFix only looks for the legacy config key. |
| 14 | (d) | Doctor's own update finalizer failing. Do not treat `--fix` exit 0 as proof the update committed. | High | High to paper over | [openclaw#197083](https://github.com/openclaw/openclaw/issues/197083): post-install Doctor WAL publication leaves a 2026.11.3 update partially finalized. [openclaw#199028](https://github.com/openclaw/openclaw/issues/199028): `gateway-recovery-verification` failure on 2026.11.3. [openclaw#198787](https://github.com/openclaw/openclaw/issues/198787): `candidate-doctor` failure on 2026.9.7. |
| 15 | (d) | Cron and heartbeat jobs failing on a 10 s OAuth refresh after a successful refresh elsewhere. | Medium | Medium | [openclaw#89278](https://github.com/openclaw/openclaw/issues/89278). Neither the default doctor lint set nor ClawFix's log matchers name this timeout. |
| 16 | (d) | Port held by another process, and a dead listener. Keep ClawFix's probes. | High | Low to keep | `docs/research/open-source-integrations.md` lab note: default doctor lint did not report reachability. 2026.11.3 still puts `core/doctor/gateway-health` and `core/doctor/gateway-daemon` behind `defaultEnabled: false` (`doctor-core-checks.ts:640-657`). ClawFix's listener and status probes are the ones that fire (`diagnostics.js:983-988`, `:1130-1162`). |

Items already aligned, so they are not work:

- Heartbeat config repairs do not write `agents.defaults.heartbeat`. They tell the operator to run `openclaw doctor --fix` (`src/known-issues.js:816-830`).
- ClawFix still runs `security audit --json` separately. That is required: `core/doctor/security` is not the audit, and on 2026.11.3 it did not report `gateway.loopback_no_auth`.
- The 120 s lint budget matches `doctor-process.ts`. A killed lint is not turned into a finding (`cli/bin/native-diagnostics.js:187-198`).
- `core/doctor/skills-readiness` stays out of the default run. ClawFix's `--skip` is redundant with `defaultEnabled: false` and is worth keeping if upstream flips the default.

## First changes

1. Parse the exit-2 blocked envelope in the CLI collector and the hosted script, and keep `requirement`, `errorCode`, and `line` on every accepted finding. Fixtures are the 2026.11.3 captures above, with the temp state path rewritten to `~/.openclaw/...` and the Node binary path removed.
2. For the exact missing-token `core/doctor/gateway-auth` shape, dedupe it against an existing `gateway.loopback_no_auth` security finding and otherwise point it at the existing `gateway-loopback-no-auth` repair. Dedupe `core/doctor/security` against a security-audit finding whose check id equals `requirement` when that requirement is a single check id. Do not map SecretRef gateway-auth findings onto the token repair.
