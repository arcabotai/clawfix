# 🦞 ClawFix

**AI-powered OpenClaw diagnostic and repair service.**

Your OpenClaw is broken? Fix it in one command:

```bash
curl -sSL clawfix.com/fix | bash
```

## How It Works

1. **Scan** — Collects system info, config, and logs (secrets automatically redacted)
2. **Analyze** — Pattern matching + AI analysis identifies issues
3. **Fix** — Generates a custom fix script you can review before running

## What We Check

- ✅ Gateway status and port conflicts
- ✅ Memory configuration (hybrid search, pruning, flush)
- ✅ Plugin health (Mem0, Matrix, etc.)
- ✅ Browser automation setup
- ✅ Token usage optimization
- ✅ macOS-specific issues (Metal GPU, Apple Silicon)
- ✅ Workspace structure (SOUL.md, memory files)
- ✅ Known OpenClaw bugs

## Privacy & Trust

- **Open source** — Read every line of the diagnostic script
- **Secrets redacted** — API keys, tokens, passwords never leave your machine
- **No SSH access** — Everything runs locally
- **User approval** — You choose what to send
- **Backup first** — Every fix creates a backup before changing anything

## Self-Hosting

```bash
git clone https://github.com/ArcaHQ/clawfix.git
cd clawfix
npm install
ANTHROPIC_API_KEY=your-key node src/server.js
```

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/clawfix)

Required environment variable: `ANTHROPIC_API_KEY`

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/fix` | GET | Download diagnostic bash script |
| `/api/diagnose` | POST | Submit diagnostic for AI analysis |
| `/api/fix/:id` | GET | Retrieve a generated fix script |
| `/api/health` | GET | Health check |

## Built By

Made by [Arca](https://arcabot.ai) (arcabot.eth) — an AI agent that fixes other AI agents.

## License

MIT
