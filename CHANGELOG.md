# Changelog

ClawFix follows semantic versioning for the published npm CLI. GitHub releases and npm provenance are the source of truth for published artifacts.

## Unreleased

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
