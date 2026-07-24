# 🦞 ClawFix

[![CI](https://github.com/arcabotai/clawfix/actions/workflows/ci.yml/badge.svg)](https://github.com/arcabotai/clawfix/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/clawfix.svg)](https://www.npmjs.com/package/clawfix)
[![npm downloads](https://img.shields.io/npm/dm/clawfix.svg)](https://www.npmjs.com/package/clawfix)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**OpenClaw diagnostics and guarded repairs.**

ClawFix scans locally, redacts recognized secrets, and matches failures against deterministic rules. Optional AI analysis can explain unmatched problems when it is configured on the selected server. Model output never becomes executable shell.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Security](#security--transparency) · [Self-hosting](#self-hosting) · [Contributing](#contributing)

## Quick Start

```bash
# Recommended: download, verify, then install with bash (no global npm)
curl --fail --show-error --silent --location https://clawfix.dev/install --output install-clawfix.sh
cat install-clawfix.sh
shasum -a 256 install-clawfix.sh
curl --fail --show-error --silent https://clawfix.dev/install/sha256
# Compare the printed hashes exactly before running the script.
bash install-clawfix.sh

# Then run
clawfix --dry-run
clawfix
```

### Alternative: npx

```bash
npx clawfix@0.11.1
npx clawfix@0.11.1 --dry-run
```

### Legacy diagnostic script

If you only want the older bash diagnostics script (not the full CLI install):

```bash
curl --fail --show-error --silent --location https://clawfix.dev/fix --output clawfix.sh
cat clawfix.sh
shasum -a 256 clawfix.sh
curl --fail --show-error --silent https://clawfix.dev/fix/sha256
# Compare the printed hashes exactly before running the script.
bash clawfix.sh
```

## Usage and maintenance

ClawFix is an open-source operator tool with active releases and public maintenance records.

Verified on July 22, 2026:

- The npm CLI recorded [1,175 downloads since February 22](https://api.npmjs.org/downloads/point/2026-02-22:2026-07-22/clawfix), including [247 downloads in the previous 30-day period](https://api.npmjs.org/downloads/point/2026-06-22:2026-07-21/clawfix).
- The hosted service reported [192 completed diagnoses](https://clawfix.dev/api/stats).
- Current pull-request and `main` CI runs tests on Node.js 22 and 24, remediation proofs, ShellCheck-backed repair validation, a production dependency audit, npm package inspection, and a container smoke test. The release workflow repeats the Node.js 24 test, repair, audit, and package gates before publishing.

Maintenance records are public in the [changelog](CHANGELOG.md), [releases](https://github.com/arcabotai/clawfix/releases), [issues](https://github.com/arcabotai/clawfix/issues), and [pull requests](https://github.com/arcabotai/clawfix/pulls).

## How It Works

1. **Run one command** — The diagnostic script scans your OpenClaw config, logs, plugins, ports, and listener ownership
2. **Evidence is correlated** — Native config validation, status, Doctor, security audit, and 49 deterministic patterns run first. Optional AI analysis can explain unmatched problems when available
3. **Review & apply** — You get a commented fix script. Nothing runs without your approval

Failures and warnings are counted as issues. Performance and quality tuning is shown separately as optional optimization advice.

## What It Detects (49 deterministic patterns)

- 💀 Gateway crashes (port conflicts, process hangs, restart loops)
- 🧠 Memory issues (Mem0 silent failures, missing flush, broken search)
- 🌐 Browser automation (CDP port failures, extension loading, headless issues)
- 🔌 Plugin configs (broken plugins, wrong settings)
- 💸 Token waste (excessive heartbeats, no pruning, bloated context)
- 🍎 macOS quirks (Metal GPU crashes, Apple Silicon issues)
- 🔧 Service manager crashes (launchd/systemd SIGTERM recovery, crash loops)
- 👻 Zombie processes (PID exists but port not listening)
- 📜 Error log bloat (chrome extension spam, handshake storms)
- 🐕 Gateway watchdog recommendations (independent health checks)
- ⚡ Native Codex harness drift (PI route fallback, session-store permissions, shell `CODEX_HOME`, fast tier, timeout boundaries)
- 🧵 Model provider prefix typos (`codex/gpt-5.4` vs `openai-codex/gpt-5.4` — silent 403 + fallback loop)
- 🎣 Silently-dropped Discord group messages (`groupPolicy=allowlist` with empty `allowFrom`)
- 🔒 Plaintext secrets in config (flags fields that should be SecretRefs pointing at `~/.openclaw/.env`)
- 🪪 Invalid `GH_TOKEN`/`GITHUB_TOKEN` env overrides masking a working `gh` login
- 📡 Stale self-paired nodes producing endless `skills-remote` probe timeouts
- 🌊 Session context overflow (>100 % window, auto-compaction failing)
- 🔐 FileVault blocking unattended reboots (macOS)
- 📦 LaunchAgent plist carrying stale managed-env secrets after a `.env` migration (macOS)
- 🧩 OpenClaw/Node.js engine incompatibility, including failed `openclaw --version` output
- 🩺 Native OpenClaw Doctor findings from its read-only structured lint mode
- 🛡️ Native OpenClaw security-audit findings with credential-redacted evidence
- 🚧 Gateway port ownership when another process blocks OpenClaw startup

## Security & Transparency

ClawFix prompts before upload by default. Use `--dry-run` or `--show-data` to inspect the diagnostic payload; explicit automation flags can skip the prompt.

### What Data Is Collected

| Category | Data | Sensitive? |
|----------|------|-----------|
| System | OS type, version, architecture | No |
| Runtime | Node.js version, npm version | No |
| OpenClaw | Version, runtime compatibility, schema validity, allowlisted gateway/service status | No |
| Doctor | Check ID, severity, message, config path, and fix hint (up to 100 findings) | Potentially low risk; inspect with `--dry-run` |
| Security audit | Summary, redacted finding text, remediation hint, suppression count | Potentially low risk; inspect with `--dry-run` |
| Ports | Listening state, process name, PID, and endpoint | Low risk |
| Codex | Expected OpenClaw Codex home path and shell-match booleans | No |
| Config | Configuration fields and non-secret values; recognized secrets are redacted and the top-level config `env` block is omitted | Redacted |
| Logs | Node CLI: up to 30 matching `gateway.log` lines and 200 recent `gateway.err.log` lines. Bash fallback: up to 30 matching gateway lines and 50 recent stderr lines | Potentially sensitive; inspect with `--dry-run` |
| Workspace | File counts, existence checks (SOUL.md etc.) | No |
| Identity | Hostname **SHA-256 hashed** (first 8 chars only) | Anonymized |

### What is excluded or redacted

- Recognized API keys, tokens, and passwords are redacted before upload
- ❌ File contents (SOUL.md, AGENTS.md, memory files, chat history)
- The top-level config `env` block is omitted; nested configuration values may remain unless recognized by the redactor
- ❌ Real hostname (only a short one-way host hash is sent)
- IP addresses are used transiently for abuse throttling and are not included in diagnostic records
- Error logs are unstructured and may contain identifiers the redactor cannot recognize; inspect with `--dry-run` before consenting

### Verification Tools

```bash
# See exactly what would be sent (sends nothing)
npx clawfix --dry-run

# Show the full payload, then ask to send
npx clawfix --show-data

# Verify the reviewed local copy. The printed hashes must match exactly.
shasum -a 256 clawfix.sh
curl --fail --show-error --silent https://clawfix.dev/fix/sha256
```

### Design Decisions

- **Consent by default**: The CLI asks before upload unless you explicitly use `--yes`, `-y`, or `CLAWFIX_AUTO=1`
- **Fix scripts are not auto-executed**: They're saved to `/tmp` for your review
- **No model-authored shell**: AI output is advisory only; executable repairs come from reviewed deterministic snippets
- **Repair validation**: Combined deterministic scripts must pass `bash -n`; hosted builds also run ShellCheck and fail closed on validator errors
- **Feedback is opt-in**: Repair scripts only report outcomes when run with `CLAWFIX_SEND_FEEDBACK=1`
- **Auto-backup**: Every fix script backs up `openclaw.json` before modifying
- **Open source**: [The CLI, server, and diagnostic script](https://github.com/arcabotai/clawfix) are public under the MIT license
- **npx over curl**: We recommend `npx clawfix` as the primary method because the source is auditable on [npm](https://www.npmjs.com/package/clawfix) and GitHub

### CLI Options

```
npx clawfix [options]

  --dry-run        Scan locally, show what would be collected, send nothing
  --no-send        Same as --dry-run
  --json           Machine-readable local scan; sends nothing
  --server URL     Use custom API server
  --help, -h       Show help
  --version, -v    Show version
```

## Self-Hosting

Don't trust our server? Run your own:

```bash
git clone https://github.com/arcabotai/clawfix
cd clawfix
npm ci
npm start
```

Point the CLI at your instance:

```bash
CLAWFIX_API=http://localhost:3001 npx clawfix
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `AI_PROVIDER` | `openrouter` | AI provider label used for OpenRouter request metadata |
| `AI_MODEL` | `deepseek/deepseek-v4-flash` | OpenRouter model for analysis and chat |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `AI_API_KEY` | — | Generic key override for OpenAI-compatible endpoints |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible API base URL |
| `AI_MAX_TOKENS` | `3000` | Maximum generated tokens per AI request |
| `AI_TIMEOUT_MS` | `90000` | Upstream AI request timeout in milliseconds |
| `CLAWFIX_API_TOKEN` | — | Bearer token required by AI endpoints; setting it enables authenticated paid AI |
| `ALLOW_PUBLIC_AI` | — | Set to `1` to explicitly enable unauthenticated paid AI; disabled by default even when an AI key exists |
| `AI_DAILY_REQUEST_LIMIT` | `200` | Per-process daily cap across paid AI diagnosis and chat requests; use a provider spending cap or shared store across replicas |
| `AI_MAX_CONCURRENCY` | `4` | Shared maximum in-flight paid AI requests |
| `DIAGNOSE_RATE_LIMIT` | `10` | Per-client diagnosis requests per rate-limit window |
| `CHAT_RATE_LIMIT` | `30` | Per-client chat requests per rate-limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Per-client rate-limit window |
| `DATABASE_URL` | — | PostgreSQL URL for persistence |

## OpenClaw Sandbox Lab

The development lab provisions the public ClawFix repository and a pinned OpenClaw release inside a disposable Blaxel sandbox. It intentionally does not upload your local workspace or `.env` file.

```bash
# Create the retained sandbox, then install OpenClaw and public ClawFix
npm run lab:create
npm run lab:provision

# Inspect versions and state, or run reversible fault scenarios
npm run lab:status
npm run lab:scenarios

# Stop keep-alive processes while retaining the sandbox for later work
npm run lab:stop
```

Override the tested OpenClaw release with `OPENCLAW_LAB_VERSION`. The default is pinned to `2026.6.11` because the current Blaxel base image's Node.js `24.11.1` does not satisfy OpenClaw `2026.7.1`'s engine range.

The scenario suite restores changed configuration and processes in a `finally` block. See the [open-source integration research](docs/research/open-source-integrations.md) for the evidence matrix and recommended tool stack.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page |
| `/fix` | GET | Diagnostic bash script |
| `/fix/sha256` | GET | Script hash for verification |
| `/api/diagnose` | POST | Submit diagnostic data |
| `/api/fix/:fixId` | GET | Retrieve fix results |
| `/api/stats` | GET | Service statistics |
| `/api/feedback/:fixId` | POST | Report if fix worked |
| `/results/:fixId` | GET | Web-based results page |

## Hosted service

The CLI and server are MIT licensed. `clawfix.dev` is currently free to use. Hosted limits may change; self-hosting remains available under the MIT license.

## Contributing

Found a new OpenClaw issue pattern? Start with the [diagnostic rule proposal](https://github.com/arcabotai/clawfix/issues/new?template=diagnostic-rule.yml), then read [CONTRIBUTING.md](CONTRIBUTING.md).

Before opening a PR:

```bash
npm test
npm run validate:repairs   # requires ShellCheck
npm audit --omit=dev
```

CI runs these checks on Node.js 22 and 24, verifies the npm publish manifest, and builds the production container.

Security and privacy failures should be reported privately. See [SECURITY.md](SECURITY.md).

## Maintainers

ClawFix is maintained by [Luis Felipe Abarca](https://github.com/felirami) and Arca's public [`arcabotai`](https://github.com/arcabotai) account. Felipe authored the [v0.9.1 repair-safety overhaul](https://github.com/arcabotai/clawfix/pull/4). [`CODEOWNERS`](.github/CODEOWNERS) names both accounts for repository-wide review, while Arca's agent identities contribute under their own public authorship.

## License

[MIT](LICENSE)

---

Made by [Arca](https://arcabot.ai) (arcabot.eth) · Not affiliated with OpenClaw
