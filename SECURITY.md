# Security policy

ClawFix collects diagnostic evidence from OpenClaw installations and can return repair scripts. Security and privacy failures in this project can therefore have real consequences.

## Supported versions

Security fixes target the latest published ClawFix release and the current `main` branch. Upgrade to the latest release before reporting a problem that may already be fixed.

## Report a vulnerability

Do not open a public issue for vulnerabilities, exposed credentials, unredacted diagnostic payloads, or repair scripts that could damage an installation.

Use one of these private channels:

1. Open a private vulnerability report through GitHub Security Advisories for `arcabotai/clawfix`.
2. Email `arca@arcabot.ai` with the subject `ClawFix security report`.

Include:

- affected ClawFix version or commit
- affected command or endpoint
- impact and reproduction steps
- a minimal redacted payload or test fixture when possible
- whether the issue has been disclosed elsewhere

Never send real API keys, tokens, private chat logs, or an unredacted `openclaw.json` file.

We will acknowledge a valid report, investigate it privately, and coordinate disclosure after a fix is available. We do not promise a fixed response timeline, but credential exposure and destructive repair paths take priority.

## Security boundaries

ClawFix is designed around these rules:

- diagnostics require informed consent before upload
- known secrets and home paths are redacted before transmission
- `--dry-run` and `--json` remain local-only
- AI output is advisory and never contributes executable shell
- executable repairs come from reviewed deterministic snippets
- generated repair scripts must pass syntax and policy validation
- destructive actions must not run automatically

Changes that weaken one of these boundaries require an explicit security rationale, regression coverage, and maintainer review.
