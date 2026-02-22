# 🦞 ClawFix

**AI-powered OpenClaw diagnostic and repair service.**

Fix your broken OpenClaw in one command. No SSH access needed. Runs locally, sends redacted logs, gets a fix script back.

## Quick Start

```bash
curl -sSL clawfix.dev/fix | bash
```

## How It Works

1. **Run one command** — The diagnostic script scans your OpenClaw config, logs, plugins, and ports
2. **AI analyzes** — Pattern matching catches 12+ known issues instantly. AI handles novel problems
3. **Review & apply** — You get a commented fix script. Nothing runs without your approval

## What It Detects

- 💀 Gateway crashes (port conflicts, process hangs, restart loops)
- 🧠 Memory issues (Mem0 silent failures, missing flush, broken search)
- 🌐 Browser automation (CDP port failures, extension loading, headless issues)
- 🔌 Plugin configs (broken plugins, wrong settings)
- 💸 Token waste (excessive heartbeats, no pruning, bloated context)
- 🍎 macOS quirks (Metal GPU crashes, Apple Silicon issues)

## Trust & Security

- **Open source** — Read every line before running
- **Secrets redacted** — API keys, tokens, passwords stripped before sending
- **Review before apply** — Fix scripts shown to you first
- **Auto backup** — Config backed up before any changes

## Self-Hosting

```bash
git clone https://github.com/arcaboteth/clawfix
cd clawfix
npm install
npm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `AI_PROVIDER` | `openrouter` | AI provider (openrouter, anthropic, deepseek, together) |
| `AI_MODEL` | `minimax/minimax-m2.5` | Model for analysis |
| `AI_API_KEY` | — | API key for AI provider |
| `OPENROUTER_API_KEY` | — | OpenRouter API key (alternative) |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page |
| `/fix` | GET | Diagnostic bash script |
| `/api/diagnose` | POST | Submit diagnostic data |
| `/api/fix/:fixId` | GET | Retrieve fix results |
| `/api/stats` | GET | Service statistics |
| `/api/health` | GET | Health check |
| `/results/:fixId` | GET | Web-based results page |

## Pricing

- **Free** — Pattern matching scan (12+ known issues)
- **$2** — AI-powered analysis + fix script
- **$9/mo** — Continuous monitoring (coming soon)

## Contributing

Found a new OpenClaw issue pattern? PRs welcome! Add it to `src/known-issues.js`.

## License

MIT

---

Made by [Arca](https://arcabot.ai) (arcabot.eth) · Not affiliated with OpenClaw
