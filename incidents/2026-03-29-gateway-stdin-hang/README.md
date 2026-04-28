# Incident: Gateway Fails to Start After Update (2026-03-29)

Two independent bugs discovered during a 16-hour gateway outage after a self-update from v2026.3.13 to v2026.3.28.

## Files in this folder

### Documentation

| File | Description |
|------|-------------|
| `INCIDENT-REPORT.md` | Full incident report with timeline, root cause analysis, resolution steps, and lessons learned |
| `DIAGNOSTIC-PLAYBOOK.md` | Step-by-step runbook for diagnosing gateway startup failures (reusable for future incidents) |

### Fix Scripts (ready to run)

| File | Description |
|------|-------------|
| `scripts/fix-launchd-stdin.sh` | Patches the LaunchAgent plist to add `StandardInPath=/dev/null`. Safe, idempotent. |
| `scripts/rollback-version.sh` | Full rollback script: installs working version, fixes plist, restarts gateway. Usage: `bash rollback-version.sh [version]` |

### Code Patches (for integrating into clawfix codebase)

| File | What to patch | Description |
|------|---------------|-------------|
| `patches/known-issues-additions.js` | `src/known-issues.js` | 4 new known issue patterns: `launchd-missing-stdin-path`, `gateway-run-broken-v2026.3.28`, `plugin-id-mismatch-spam`, `post-update-restart-failure` |
| `patches/cli-builtin-fixes-additions.js` | `cli/bin/clawfix.js` | 3 new builtin fix entries for the CLI's `BUILTIN_FIXES` map |
| `patches/diagnostic-script-additions.sh` | `src/routes/script.js` | 6 new diagnostic checks: plist stdin path, process vs port, restart sentinel, broken version detection, watchdog failure loop, tailscale config mismatch |
| `patches/diagnose-system-prompt-additions.md` | `src/routes/diagnose.js` | 5 new real-world crash scenarios for the AI system prompt |

## How to integrate

### 1. Add known issue patterns
Copy the 4 issue objects from `patches/known-issues-additions.js` into the `KNOWN_ISSUES` array in `src/known-issues.js`.

### 2. Add CLI builtin fixes
Copy the 3 fix entries from `patches/cli-builtin-fixes-additions.js` into the `BUILTIN_FIXES` map in `cli/bin/clawfix.js`.

### 3. Add diagnostic checks
Integrate the 6 bash functions from `patches/diagnostic-script-additions.sh` into the diagnostic script embedded in `src/routes/script.js`, and add corresponding fields to the JSON payload.

### 4. Update AI system prompt
Copy the new crash scenarios from `patches/diagnose-system-prompt-additions.md` into the `SYSTEM_PROMPT` constant in `src/routes/diagnose.js`.

### 5. Bump versions
- `package.json`: bump server version
- `cli/package.json`: bump CLI version
- Update detection count in `README.md` (currently says "30+ issues")

## Bugs discovered

| Bug | Severity | Versions Affected | Status |
|-----|----------|-------------------|--------|
| LaunchAgent missing `StandardInPath` causes stdin hang | Critical | All versions on macOS | Not fixed upstream -- `openclaw gateway install` still omits it |
| `gateway` / `gateway run` exits 0 without starting server | Critical | 2026.3.24, 2026.3.28 | Not reported upstream yet |
| Plugin id mismatch warnings spam | Medium | 2026.3.28 | Cosmetic, not reported |
| Post-update restart failure (no automatic recovery) | High | All versions | Architectural -- self-updates are inherently risky |
