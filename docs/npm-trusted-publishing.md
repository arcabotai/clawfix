# npm trusted publishing

ClawFix publishes from GitHub Actions using npm's OpenID Connect (OIDC) trusted-publisher flow. No long-lived npm write token is required.

## One-time npm package setup

Open the `clawfix` package settings on npmjs.com and add a **Trusted Publisher** with:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `arcabotai` |
| Repository | `clawfix` |
| Workflow filename | `release.yml` |
| Environment name | Leave empty |
| Allowed actions | `npm publish` |

Enter only `release.yml`, not `.github/workflows/release.yml`.

## Release behavior

- Normal releases run when a `v*` tag is pushed.
- Manual dispatch is recovery-only and requires an existing version tag whose package sources match `main`.
- The workflow uses a GitHub-hosted runner, `id-token: write`, Node 24, and npm 11.15.0.
- npm exchanges GitHub's short-lived OIDC identity for publish authorization and adds provenance automatically.
- The workflow runs tests, remediation proof, repair validation, dependency audit, and package allowlist verification before publishing.

After the first successful OIDC publish, remove the repository `NPM_TOKEN` secret and configure npm package **Publishing access** to require 2FA and disallow traditional tokens.

Source: https://docs.npmjs.com/trusted-publishers/
