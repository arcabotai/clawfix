# Contributing to ClawFix

ClawFix turns real OpenClaw failures into deterministic diagnostics and guarded repairs. Contributions should be narrow, reproducible, and safe to run on someone else's machine.

## Before opening a pull request

1. Search existing issues and pull requests.
2. Open an issue for a new diagnostic rule or behavior change.
3. Remove credentials, hostnames, chat content, and private paths from every fixture and log excerpt.
4. Keep repairs deterministic. AI-generated text may explain a problem, but it must not become executable shell.

## Development setup

Requirements:

- Node.js 22 or 24 for the full repository
- npm
- ShellCheck for repair validation

```bash
npm ci
npm test
npm run prove:remediation
npm run validate:repairs
npm audit --omit=dev
```

Verify the publishable CLI payload too:

```bash
manifest=$(mktemp)
npm pack ./cli --dry-run --json --cache /tmp/clawfix-npm-cache > "$manifest"
node scripts/verify-cli-package.mjs "$manifest"
rm -f "$manifest"
```

## Adding a diagnostic rule

A useful diagnostic rule needs:

- a stable ID and clear severity
- evidence from a real or reproducible failure
- a detector that avoids broad substring matching
- a regression test for positive and negative cases
- redacted user-facing evidence
- a repair only when the action is bounded, reversible, and safe

Do not bundle unrelated rules into one pull request.

## Pull request checklist

- [ ] The issue or failure mode is reproducible.
- [ ] Added fixtures contain no secrets or personal data.
- [ ] New behavior has regression coverage.
- [ ] Local checks listed above pass.
- [ ] Documentation matches the behavior.
- [ ] The change does not weaken consent, redaction, or repair validation.

## Releases

Maintainers publish the CLI through GitHub Actions trusted publishing. Do not publish from a local npm token. Release tags, the root package version, and `cli/package.json` must agree.

See [CHANGELOG.md](CHANGELOG.md) for release history and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
