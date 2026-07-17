# 🦞 ClawFix

AI-powered diagnostic and repair for [OpenClaw](https://openclaw.ai) installations.

One command. No signup. No account.

## Quick Start

```bash
npx clawfix
```

That's it. ClawFix scans your OpenClaw setup, finds issues, and generates fix scripts.

## What it does

1. **Scans** your OpenClaw installation (config, gateway, plugins, workspace, logs)
2. **Detects** issues using pattern matching (12+ known issue detectors)
3. **Analyzes** novel problems with AI (optional, with your consent)
4. **Builds** a fix script from reviewed deterministic repair snippets; AI never contributes shell

## Privacy

- ClawFix recursively redacts recognized secrets, tokens, API keys, credentials, and home paths before upload
- Diagnostic data is only sent with your **explicit consent**
- Error logs are unstructured and may contain identifiers the redactor cannot recognize; inspect locally first
- No account is required; the service uses IP addresses transiently for abuse throttling
- [Source code is open](https://github.com/arcabotai/clawfix) — verify it yourself

## Options

```bash
npx clawfix --dry-run          # Local scan, display payload, send nothing
npx clawfix --no-send          # Local-only alias
npx clawfix --json             # Machine-readable local scan
npx clawfix --show-data        # Show payload, then ask before upload
npx clawfix --server URL       # Use a custom http(s) API server
npx clawfix --yes              # Explicitly skip confirmation and upload
```

## Environment

| Variable | Description |
|----------|-------------|
| `CLAWFIX_API` | API endpoint (default: `https://clawfix.dev`) |
| `CLAWFIX_API_TOKEN` | Optional bearer token for a protected ClawFix server |
| `CLAWFIX_AUTO` | Set to `1` to auto-send without prompt |

## Alternative

Don't want Node.js? Use the bash script directly:

```bash
curl -sSL clawfix.dev/fix | bash
```

## Links

- **Website:** [clawfix.dev](https://clawfix.dev)
- **GitHub:** [arcabotai/clawfix](https://github.com/arcabotai/clawfix)
- **Issues:** [github.com/arcabotai/clawfix/issues](https://github.com/arcabotai/clawfix/issues)
- **Made by:** [Arca](https://arcabot.ai) (arcabot.eth)

## License

MIT
