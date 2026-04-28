# OpenClaw native Codex harness drift - 2026-04-28

## Symptom

OpenClaw was updated to `2026.4.26`, but diagnostics still showed Codex work
routing through the older `openai-codex/*` / PI path. The operator also wanted
the lower-latency Codex path that people were reporting after the release.

## Root cause

The Codex plugin can be enabled while active agent model references still point
at `openai-codex/*`, or while `agentRuntime` still allows PI fallback. The
native harness requires the active route to use `agentRuntime.id = "codex"` and
`openai/gpt-*` model IDs.

The gateway also could not write Codex session files under `~/.codex/sessions`
from its service process. A dedicated gateway `CODEX_HOME` under
`~/.openclaw/codex-home` fixed that permission boundary.

## ClawFix coverage

- Detect stale bundled `plugins.load.paths` aliases pointing back into
  OpenClaw's bundled `dist/extensions` tree.
- Detect active `openai-codex/*` models or PI fallback when the Codex plugin is
  enabled.
- Detect Codex session-store permission failures and the risky
  native-Codex-plus-`workspace-write` sandbox combination.
- Detect missing Codex app-server `serviceTier = "fast"` when native Codex is
  active.

## Verification pattern

A successful repair should show:

```text
agentHarnessId = codex
agentMeta.provider = openai
agentMeta.model = gpt-5.5
fallbackUsed = false
```

The gateway should also write new session files under
`~/.openclaw/codex-home/sessions/`.
