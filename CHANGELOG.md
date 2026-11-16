# Changelog

ClawFix follows semantic versioning for the published npm CLI. GitHub releases and npm provenance are the source of truth for published artifacts.

## Unreleased

- Detect service start failures outside the macOS LaunchAgent path. `windows-task-readiness-timeout` matches the scheduled-task readiness timeout and a failed task last result. `antivirus-gateway-blocked` matches a Norton `IDP.HELU.PSE` signature blocking the gateway or node. `systemd-service-stuck` matches a unit that is activating, deactivating (`stop-sigterm`), or failed, including the journal lines. These findings are detect-only. The LaunchAgent SIGTERM detector is unchanged, and a more specific service finding replaces the generic gateway-not-running finding.
- Detect a `memory_search` stall from the 15s timeout (`MemorySearch timed out after 15s`, `memory-lancedb embedding timed out`) or from a `.reindex-lock.sqlite` file that is 0 bytes or older than that deadline while no reindex process is alive. The finding names each lock path, size, and age. A fresh non-empty lock held by a live reindex is not a match. Doctor memory search stays opt-in: `openclaw doctor --lint --json --only core/doctor/memory-search` or `--all`, then `openclaw memory status --deep`. ClawFix does not delete the lock. Stop the gateway and rename a leftover lock aside.
- Detect three gateway auth failures that are not `mode=none`. `gateway-auth-removed` fires only when a backup still has token or password mode, or the log says `gateway.auth REMOVED` during `config reload: gateway.auth.mode`. `auth-profile-migration-required` matches `AUTH_PROFILE_MIGRATION_REQUIRED` and a Doctor archive that did not replay credentials. `stale-device-token` matches `withheld-cross-device`, `device token mismatch (rotate/reissue device token)`, and the stale device-token pattern. Token values are not printed. These findings are detect-only, and they replace a generic gateway-auth finding for the same root cause.
- Detect a state-lock or state-lease deadlock from `owns this state directory`, `owns state-lifecycle`, `GatewayLockError`, and doctor lint warnings carrying `OPENCLAW_STATE_LEASE_ABORTED`. The finding names the holder pid, command, and age when it can read them, and whether that process is alive. `openclaw gateway recover-lock` runs only when every holder pid is proven dead or reused by a non-OpenClaw command, after a lock-file backup. A live holder is not repairable. The state directory and SQLite files are not deleted.
- Name the Node binary that fails OpenClaw's engine range. The finding reports the shell node, the gateway service node from a readable LaunchAgent, systemd unit, or scheduled task, and a Companion tools node, with the path and version. A gateway node that is already inside the range is lower severity. The range comes from the installed `package.json` `engines.node` field when it can be read, otherwise Node 24.22.1+ or 26.12.1+. ClawFix does not install or switch Node.
- Detect retired `agents.defaults.heartbeat` (and per-agent heartbeat keys) when they are still in config or when update admission returns `invalid-config` for `agents.defaults` before Doctor can migrate them. The finding names the key path. A successful doctor lint that already reported the heartbeat migration checks replaces this leftover-key finding instead of repeating it. Deleting the block is not a repair.
- Detect `plugins.installs` and `Unrecognized key: "installs"`. An empty object can be removed after a config backup and `openclaw config validate`; populated install records are left in place.

- Detect a post-upgrade migration crash loop from the startup lines `Legacy workspace setup state requires migration`, `missing or drifted index idx_agent_session_nodes_active`, and a legacy `sessions.json` that still needs migration. A gateway restart does not clear these. ClawFix does not run `doctor --fix` for them: that command stops the gateway, and on the reported releases it refused the workspace conflict and skipped per-agent session stores.
- Detect a stalled or failed `doctor --fix` from a repeating SQLite read-only snapshot, `sqlite-source-revision` content-version respawn, an incomplete process census after the gateway was stopped, a SIGTERM cleanup failure, or a doctor process still running after 15 minutes. Guidance is to escalate from SIGTERM to SIGKILL and not to start another unbounded `--fix`.
- Bound every doctor invocation ClawFix starts to 120 seconds. The process is sent SIGTERM and then SIGKILL. If the gateway was running before that invocation and is stopped after it, ClawFix restarts the gateway once and does not run doctor again.

## 0.12.0 - 2026-08-02

- Expanded the guarded repair catalog from 1 to 5 entries: `gateway-not-running` (needs systemd/launchd), plus four config toggles applied and verified through OpenClaw's own CLI — `auto-update-enabled-warning`, `gateway-loopback-no-auth`, `no-hybrid-search`, and `no-memory-flush`. Every toggle shares one `configToggleRepair` contract with a read-back verification and a rollback path.
- Fixed `checkGatewayRunning()` reporting a repair as applied when nothing was actually listening on the gateway port; the listening port is now the sole verdict, never process-status prose or PIDs.
- Closed two unauthenticated webhook holes: the Resend/Svix inbound-email relay and the Lemon Squeezy payment webhook both previously skipped signature verification when unconfigured, or verified against the re-serialized body instead of the raw bytes. Both now fail closed on a missing secret, missing raw body, or bad signature, with constant-time comparison.
- Removed the payment surface entirely (`/api/checkout`, the payment page, the Lemon Squeezy webhook handler, and the unused verifier) after finding a configured store could charge a customer without recording the payment anywhere. `clawfix.dev` has no paid tier and no payment path.
- Added a Linux musl (Alpine) target to the standalone OpenTUI binary build and release matrix; ClawFix now runs on Alpine-based OpenClaw containers.
- Fixed the remote-repair flow silently dropping server-proposed repairs; the TUI now resolves `repair.proposed` events against a local finding before opening the approval dialog, and never renders a server-authored plan as if it were local.
- Added a TUI quit path (Ctrl+D, or Ctrl+C while idle); previously only `SIGTERM`/`SIGKILL` could end a session.
- Fixed the TUI sidebar renumbering findings by severity while `fix <#>`/`explain <#>` indexed the unsorted list, so a number shown in the sidebar could resolve to the wrong finding.
- Fixed the TUI status line printing the scan revision twice, which pushed the finding count off the end of the line.
- Findings are no longer titled with raw machine text (a timed-out probe surfaced as `[critical] timeout`; a parser exception surfaced its stack-trace fragment as the headline). Both now carry an actionable headline with the original text preserved as detail.
- Verified 5/5 real break-fix scenarios end-to-end against a live OpenClaw install: gateway killed, port conflict, corrupted config, loopback auth disabled, and auto-update left on all detect correctly; the repair pipeline reports `applied` or `verify_failed` truthfully against a rescan in every case.
- The port conflict ClawFix detects (a squatting process holding the gateway port) is deliberately not an automatic repair — every version of it ends in killing a process ClawFix does not own. Left as diagnosis and guidance only.
- Fixed `gateway-loopback-no-auth` reporting `applied` when `openclaw config set gateway.auth.mode token` succeeded but the follow-up `doctor --fix --generate-gateway-token` failed. The repair now restores the previous auth mode after token-generation failure, and the engine treats any nonzero or timed-out apply result as `verify_failed` before a later state check can create fake success.
- Reviewed open issue #8 (four detector candidates from superseded PR #2: persisted `__OPENCLAW_REDACTED__` placeholders, incomplete global npm installs, config written by a newer OpenClaw than the installed CLI, and structured update availability). The historical incident evidence is real, but the old patch predates the current diagnostics core and provides no current-main synthetic contracts. Per the issue's acceptance criteria, these remain separate focused follow-ups rather than being copied into 0.12.0 without fresh positive/negative fixtures.
- Added a second consent check at the TUI network boundary. A direct adapter caller can no longer upload a diagnostic or chat message with `consentGranted: false` even if a future UI refactor bypasses the privacy dialog.
- Fixed the standalone TUI ignoring the documented `CLAWFIX_API` custom-server variable and `CLAWFIX_API_TOKEN`; protected self-hosted servers now receive the bearer header consistently with the portable CLI.
- Expanded text redaction to cover generic bearer credentials, complete `Cookie:` headers, and Slack `xox*` tokens before diagnostics, errors, or chat content cross the network boundary.
- Bounded both agent-v2 and legacy `/api/chat` conversation stores by last activity and hard caps on every response path, including AI-disabled fallback and provider failures. Active long-lived chats no longer expire merely because their original creation time crossed the TTL.
- Connected client disconnects to upstream AI cancellation so abandoned requests stop provider work and release the shared concurrency slot instead of running to the provider timeout.
- Escaped results-page error text before assigning HTML, closing a DOM-injection sink.
- Fixed the portable interactive CLI omitting catalog-only repairs from its authorization set and replaced gateway-specific success/failure copy with repair-accurate outcomes.
- Added mandatory TUI tests and typechecking to CI and release builds, made native dependency installation fail closed, added real Alpine PTY smoke tests for the musl artifact, and attached GitHub build provenance attestations to TUI tarballs.
- Redacted free-text TUI messages in both the exact consent preview and final request, then bounded remote SSE time, bytes, incomplete-frame buffering, and assistant text so a hostile or wedged peer cannot keep the UI busy or grow memory indefinitely.
- Strengthened the release PTY smoke to require the literal typed probe in the composer and exit status zero; periodic redraws and crash-on-exit binaries now fail the gate.
- Disabled unsafe `fix-all` batch execution and changed remaining legacy repair prompts to default no. Every executable repair now needs its own current-state plan, explicit approval, verification, and rollback outcome.
- Added durable Resend `svix-id` idempotency when PostgreSQL is configured, a bounded single-process fallback when it is not, and retryable 503 behavior after failed forwarding.
- Corrected public repair, package-boundary, privacy, retention, and artifact-integrity language; the site no longer promises universal backups, temporary database retention, model-authored coverage, or reproducible binaries it cannot prove.

## 0.11.2 - 2026-07-24

- Shipped the full post-0.10.0 mainline as one end-to-end release: installer, hosted service, npm CLI, and OpenTUI standalone assets.
- Extracted the Node plain interface into `cli/interfaces/plain.js` and thinned `cli/bin/clawfix.js` to mode dispatch only.
- Expanded the published CLI package allowlist to 21 files, including `interfaces/plain.js`, `adapters/remote-analyzer.js`, and `core/privacy.js`.
- Added constrained agent API v2 (`POST /api/v2/agent/messages`) that streams explanations and may propose only client-supplied repair IDs — never shell.
- Added CLI remote analyzer adapter for agent v2 SSE with fragmented-frame parsing, inbound validation, local repair-ID revalidation, consent-gated uploads, and network-boundary projection/redaction.
- Added OpenTUI conversation UI (transcript, composer, privacy consent, repair approval/diff dialogs) plus standalone Bun compile pipeline with embedded wasm assets.
- Added verified bash installer at `/install` that downloads a pinned package tarball, checks integrity, and installs into `~/.clawfix` + `~/.local/bin` without global npm.
- Made download-verify-bash the recommended install path on the landing page and README. `npx clawfix@0.11.2` remains supported.

Release: https://github.com/arcabotai/clawfix/releases/tag/v0.11.2

## 0.10.0 - 2026-07-23

- Added a real diagnostic core with cancellation, deadlines, revisioned result envelopes, and stable finding identity.
- Added a guarded repair engine with immutable plans, approval tokens, and revision checks.
- Wired the first catalog repair (`gateway-not-running`) through injected OpenClaw adapters only.
- Added a session controller and offline local assistant for scan/rescan, explain, issues, and repair proposals.
- Expanded the published CLI package to the 18-file allowlisted core surface.
- Kept config-mutating legacy repairs on the compatibility path for this release.

## 0.9.1 - 2026-07-17

- Hardened diagnostic privacy and repair-safety boundaries.
- Added fail-closed validation for incomplete native diagnostic output.
- Added regression coverage for security, runtime, and CLI contracts.
- Added CI checks for Node.js 22 and 24, repair validation, npm package contents, dependency audit, and the production container.
- Switched npm releases to GitHub Actions trusted publishing with provenance.

Release: https://github.com/arcabotai/clawfix/releases/tag/v0.9.1

## 0.9.0 - 2026-06-28

- Normalized npm package metadata and synchronized the CLI version with the repository release version.
- Established the public `clawfix` npm package and release workflow baseline.

Compare: https://github.com/arcabotai/clawfix/compare/v0.9.0...v0.9.1
