# Repository-to-production deployment

`arcabotai/clawfix` is the source of truth for `https://clawfix.dev` and `https://www.clawfix.dev`.

## Normal agent workflow

1. Make a focused branch and PR. Follow `AGENTS.md`; do not edit production credentials or provider resources.
2. Merge the reviewed PR into `main` only after CI passes.
3. The main push runs CI again. It includes Node 22/24 tests, remediation/repair validation, TUI checks, the production container, and a real Cloudflare `workerd` smoke against a disposable local PostgreSQL service.
4. A successful **main push CI** starts **Deploy Cloudflare**. It checks out that exact SHA, verifies it is still current main, and independently verifies successful CI for the SHA.
5. The deployment uploads a version tagged with the Git SHA, preserves existing runtime variables/secrets and Hyperdrive, checks the uploaded binding contract, then promotes that exact version ID at 100%.
6. The workflow checks the active provider version, existing domains/exposure/cron/bindings, the live version header on both hosts, health, stats/database access, and installer hashes. A failed post-promotion check restores the prior version only if this run's version is still active.

A commit on an unmerged branch does not publish to production. A failed or stale main CI does not publish. If main advances while a version is uploading, that version is not promoted; the newer main must pass its own CI. Production deploys are serialized.

The website/backend follows main. npm packages and standalone TUI binaries still use their existing release workflows; a website deploy is not a new package release.

## Source boundaries

The Worker entry is `src/worker.js`, using the existing Express routes, `src/landing.js` website, installer and diagnostic sources. The previously deployed `migrate/cloudflare-neon` implementation is integrated with newer main fixes rather than replacing main with the old migration tree.

Runtime shell syntax validation unavailable in Workers fails closed: generated legacy combined scripts are withheld rather than described as syntax-validated. This does not authorize changing the deterministic local repair catalog.

## Provider boundary

- Account: `e320a5a80611f9a30148d452929b1fb1` (Arca Computer, Inc.).
- Existing Worker: `clawfix`.
- Existing Hyperdrive binding: `HYPERDRIVE`, ID `054e6fd0b1bb4910906bd052fbd288fc`.
- Existing cleanup cron: `*/15 * * * *`.
- Existing domain and provider preview exposure is preserved.
- Runtime variables, secret values, AI enablement and database content are not managed by this workflow.
- No database migrations run during production deployment. Schema setup in the Worker CI smoke is restricted to the disposable loopback database `clawfix_worker_ci`.
- No DNS, custom-domain, cron, billing or Railway changes occur during routine publication.

The existing deployment credential is stored only as repository secret `CLOUDFLARE_API_TOKEN`, available only to the trusted deployment step. It must never appear in source, artifacts or logs. The workflow's `GITHUB_TOKEN` has read-only contents/actions permissions. Fork PRs and PR CI cannot authorize deployment.

## Verify or recover

The workflow retains `deployment-result.json`, containing the exact SHA, version ID and rollback version ID. `X-ClawFix-Version-ID` on live responses ties the serving Worker to provider version metadata and its Git SHA tag.

For an authorized recovery, rerun **Deploy Cloudflare** on main. It still requires successful CI for the exact current SHA. If a provider command times out or fails ambiguously, read back active deployment/version state before another mutation; do not blindly retry.

A prior version can be restored with an authorized version-only deployment using the recorded rollback ID. Do not redeploy the old migration worktree over current main, rotate credentials, reset the database, or change DNS as a recovery shortcut.
