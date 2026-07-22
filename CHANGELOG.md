# Changelog

ClawFix follows semantic versioning for the published npm CLI. GitHub releases and npm provenance are the source of truth for published artifacts.

## Unreleased

- Added repository-level licensing, security reporting, contributor guidance, and maintainer documentation.
- Documented public usage evidence and maintenance ownership.
- Updated Body Parser, used through Express, to clear a production denial-of-service advisory reported by `npm audit`.

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
