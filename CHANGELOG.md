# Changelog

ClawFix follows semantic versioning for the published npm CLI. GitHub releases and npm provenance are the source of truth for published artifacts.

## Unreleased

## 0.11.0 - 2026-07-24

- Shipped the full post-0.10.0 mainline as one end-to-end release: installer, hosted service, npm CLI, and OpenTUI standalone assets.
- Extracted the Node plain interface into `cli/interfaces/plain.js` and thinned `cli/bin/clawfix.js` to mode dispatch only.
- Expanded the published CLI package allowlist to 21 files, including `interfaces/plain.js`, `adapters/remote-analyzer.js`, and `core/privacy.js`.
- Added constrained agent API v2 (`POST /api/v2/agent/messages`) that streams explanations and may propose only client-supplied repair IDs — never shell.
- Added CLI remote analyzer adapter for agent v2 SSE with fragmented-frame parsing, inbound validation, local repair-ID revalidation, consent-gated uploads, and network-boundary projection/redaction.
- Added OpenTUI conversation UI (transcript, composer, privacy consent, repair approval/diff dialogs) plus standalone Bun compile pipeline with embedded wasm assets.
- Added verified bash installer at `/install` that downloads a pinned package tarball, checks integrity, and installs into `~/.clawfix` + `~/.local/bin` without global npm.
- Made download-verify-bash the recommended install path on the landing page and README. `npx clawfix@0.11.0` remains supported.

Release: https://github.com/arcabotai/clawfix/releases/tag/v0.11.0

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
