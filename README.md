# 🦞 ClawFix

**AI-powered OpenClaw diagnostic and repair service.**

Fix your broken OpenClaw in one command. No SSH access needed. Runs locally, sends redacted logs, gets a fix script back.

## Quick Start

```bash
# Recommended — auditable source on npm + GitHub
npx clawfix

# Inspect what data would be collected (sends nothing)
npx clawfix --dry-run
```

### Alternative: curl

If you prefer, you can download and inspect the script first:

```bash
# Download, inspect, then run
curl -sSL clawfix.dev/fix > clawfix.sh
cat clawfix.sh                          # Read every line
shasum -a 256 clawfix.sh                # Verify hash
curl -s clawfix.dev/fix/sha256          # Compare with published hash
bash clawfix.sh                         # Run after reviewing
```

## How It Works

1. **Run one command** — The diagnostic script scans your OpenClaw config, logs, plugins, and ports
2. **AI analyzes** — Pattern matching catches 30+ known issues instantly. AI handles novel problems
3. **Review & apply** — You get a commented fix script. Nothing runs without your approval

## What It Detects (v0.4.0)

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
- ⚡ Native Codex harness drift (PI route fallback, session-store permissions, fast tier)

## Security & Transparency

We take security seriously. ClawFix is designed around the principle of **informed consent** — you see everything before anything happens.

### What Data Is Collected

| Category | Data | Sensitive? |
|----------|------|-----------|
| System | OS type, version, architecture | No |
| Runtime | Node.js version, npm version | No |
| OpenClaw | Version, gateway status, port config | No |
| Config | Structure only — **all secrets redacted** | Redacted |
| Logs | Last 30 lines matching error/warn patterns | Low risk |
| Workspace | File counts, existence checks (SOUL.md etc.) | No |
| Identity | Hostname **SHA-256 hashed** (first 8 chars only) | Anonymized |

### What Is NOT Collected

- ❌ API keys, tokens, or passwords (all auto-redacted)
- ❌ File contents (SOUL.md, AGENTS.md, memory files, chat history)
- ❌ Environment variables (entire `env` block skipped)
- ❌ IP address or real hostname
- ❌ Personal data of any kind

### Verification Tools

```bash
# See exactly what would be sent (sends nothing)
npx clawfix --dry-run

# Show the full payload, then ask to send
npx clawfix --show-data

# Verify the curl script hash
curl -sSL clawfix.dev/fix | shasum -a 256
curl -s clawfix.dev/fix/sha256
```

### Design Decisions

- **Consent required**: Diagnostic data is only sent after you type "y" at the prompt
- **Fix scripts are not auto-executed**: They're saved to `/tmp` for your review
- **Auto-backup**: Every fix script backs up `openclaw.json` before modifying
- **Open source**: [100% of the code](https://github.com/arcabotai/clawfix) is public — CLI, server, diagnostic script
- **npx over curl**: We recommend `npx clawfix` as the primary method because the source is auditable on [npm](https://www.npmjs.com/package/clawfix) and GitHub

### CLI Options

```
npx clawfix [options]

  --dry-run        Scan locally, show what would be collected, send nothing
  --no-send        Same as --dry-run
  --json           Machine-readable JSON output
  --server URL     Use custom API server
  --help, -h       Show help
  --version, -v    Show version
```

## Self-Hosting

Don't trust our server? Run your own:

```bash
git clone https://github.com/arcabotai/clawfix
cd clawfix
npm install
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
| `AI_PROVIDER` | `openrouter` | AI provider (openrouter, anthropic, deepseek, together) |
| `AI_MODEL` | `minimax/minimax-m2.5` | Model for analysis |
| `AI_API_KEY` | — | API key for AI provider |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (alternative) |
| `DATABASE_URL` | — | PostgreSQL URL for persistence |

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

## Pricing

- **Free** — Pattern matching scan (30+ known issues)
- **$2** — AI-powered analysis + fix script *(free during beta)*
- **$9/mo** — Continuous monitoring *(coming soon)*

## Contributing

Found a new OpenClaw issue pattern? PRs welcome! Add it to `src/known-issues.js`.

## License

MIT

---

Made by [Arca](https://arcabot.ai) (arcabot.eth) · Not affiliated with OpenClaw
