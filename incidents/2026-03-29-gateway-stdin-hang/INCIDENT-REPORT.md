# Incident Report: Gateway Fails to Start After Update (stdin Hang + v2026.3.28 Beta Bug)

**Date:** 2026-03-29
**Duration:** ~16 hours (02:32 UTC to ~18:40 UTC)
**Severity:** Critical (full gateway outage)
**Affected Version:** 2026.3.13 -> 2026.3.28 (beta), also reproducible on 2026.3.24
**Platform:** macOS 26.3 (arm64), Node 22.22.0
**Trigger:** Self-update via Discord command (`npm i -g openclaw@beta`)

---

## Summary

After updating OpenClaw from 2026.3.13 to 2026.3.28 via a Discord-triggered self-update command, the gateway entered a crash loop and never recovered. Two independent bugs were discovered:

1. **Primary (launchd stdin hang):** The LaunchAgent plist lacked a `StandardInPath` directive, causing the Node.js process to hang during startup when launched by launchd (no TTY available). This was a latent bug that became exposed after the update triggered a service restart.

2. **Secondary (v2026.3.28 gateway run regression):** Version 2026.3.28 has a bug where both `gateway` and `gateway run` commands print the banner and exit with code 0 without starting the server. This affects all execution contexts (terminal, launchd, nohup).

---

## Timeline (all times UTC-3 / local)

| Time | Event |
|------|-------|
| 02:32:18 | Update completed: 2026.3.13 -> 2026.3.28 (`npm i -g openclaw@beta`) |
| 02:32:43 | Gateway receives SIGUSR1, begins restart |
| 02:34:06 | New version starts, logs massive plugin id mismatch warnings for all bundled plugins |
| 02:34:18 | Gateway shutdown timed out: "exiting without full cleanup" |
| 02:39:14 | First SIGTERM in crash loop -- gateway starts, hangs, launchd kills it |
| 02:39 - 18:20 | Continuous crash loop: watchdog detects DOWN every 2 minutes, fails to recover |
| ~18:20 | Investigation begins |
| ~18:40 | Root cause identified, fix applied, gateway restored on v2026.3.13 |

---

## Root Cause Analysis

### Bug 1: LaunchAgent stdin hang (CRITICAL)

**Mechanism:** When launchd spawns the gateway process, it does not provide a terminal (TTY) on stdin. Without an explicit `StandardInPath` in the plist, the stdin file descriptor is in an undefined state. The OpenClaw CLI framework (specifically the `entry.js` respawn logic or commander.js argument parsing) reads from stdin during initialization, causing the process to block indefinitely.

**Evidence:**
- Process stays alive (launchd shows `state active`) but never binds to port 18789
- Zero output written to stdout/stderr log files
- `/tmp/openclaw/` structured log shows repeated banner prints but no server startup messages
- Running the same command with `< /dev/null` from a shell works immediately (healthy in ~5 seconds)
- Running from an interactive terminal works immediately
- Running via `nohup` from a shell works immediately

**Fix:** Add `<key>StandardInPath</key><string>/dev/null</string>` to the LaunchAgent plist.

**Why it surfaced now:** The update triggered a SIGUSR1 restart. The previous launchd session may have inherited a valid stdin descriptor from the initial `launchctl load` invocation, or macOS launchd behavior changed across system sleep/wake cycles. The forced restart via SIGUSR1 -> SIGTERM -> fresh spawn cycle exposed the missing stdin.

### Bug 2: v2026.3.28 gateway command regression (HIGH)

**Mechanism:** In version 2026.3.28, the `gateway` and `gateway run` CLI commands do not start the WebSocket server. Instead, they:
1. Print the OpenClaw banner (version + tagline)
2. Exit with code 0

This happens in both `dist/index.js` (via `runLegacyCliEntry`) and `openclaw.mjs` (via `entry.js`).

**Evidence:**
- Running in a fake TTY via `script(1)`: prints banner, `EXIT_CODE: 0`
- Running via nohup: dies after ~7 seconds, exit code 0
- Same behavior on 2026.3.24 (the gateway run command is also broken there)
- Version 2026.3.13 does NOT have this bug (gateway starts correctly)

**Likely cause:** The CLI routing in `run-main-*.js` changed how the `gateway` command is dispatched. The old version treated `gateway` as a direct server start command; newer versions may require a different subcommand or the routing table was broken during refactoring.

**Note:** `2026.3.28` is both the `latest` and `beta` npm tag. This bug affects the current stable release.

### Compounding factor: Plugin id mismatch warnings

Version 2026.3.28 logs warnings for every bundled plugin:
```
plugin anthropic: plugin id mismatch (manifest uses "anthropic", entry hints "anthropic-provider")
```
This affects 40+ plugins and fills the error log, though it does not directly cause the crash.

---

## Impact

- **Full gateway outage** for ~16 hours
- **Discord bot offline** (Arca bot unreachable)
- **Watchdog unable to recover** -- launchctl reload fails with `Load failed: 5: Input/output error`
- **90+ backup .tmp files** generated in `~/Backups/openclaw-migrations/` from repeated failed recovery attempts
- **Heartbeat/cron jobs missed** during the outage window

---

## Resolution

1. Rolled back from 2026.3.28 to 2026.3.13:
   ```bash
   npm i -g openclaw@2026.3.13 --no-fund --no-audit
   ```

2. Reinstalled the LaunchAgent plist:
   ```bash
   openclaw gateway install --force
   ```

3. Added `StandardInPath=/dev/null` to the plist:
   ```xml
   <key>StandardInPath</key>
   <string>/dev/null</string>
   ```
   (Inserted before the `<key>StandardOutPath</key>` entry)

4. Loaded the service:
   ```bash
   launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   ```

5. Verified health:
   ```bash
   curl http://localhost:18789/health
   # {"ok":true,"status":"live"}
   ```

Gateway became healthy within 5 seconds.

---

## Lessons Learned

1. **LaunchAgent plists should always include `StandardInPath=/dev/null`** -- Node.js CLI tools may block on stdin when no TTY is available.

2. **Self-updates via the agent itself are risky** -- if the new version has a startup bug, the gateway cannot recover without manual intervention.

3. **The watchdog script cannot fix launchd I/O errors** -- when `launchctl load` fails with error 5, the watchdog's unload/reload cycle is ineffective.

4. **Beta versions should not be auto-deployed on production gateways** -- the update channel was set to `beta` in config, which led to installing a broken release.

5. **The `openclaw gateway install --force` command does NOT add `StandardInPath`** -- this is a bug/omission in OpenClaw's plist generation that should be reported upstream.

---

## Action Items

- [ ] Add `launchd-stdin-hang` to ClawFix known issues (detection + fix)
- [ ] Add `gateway-run-broken-2026.3.28` to ClawFix known issues
- [ ] Update the ClawFix diagnostic script to check for missing `StandardInPath` in plists
- [ ] Update the ClawFix CLI builtin fixes to patch the plist
- [ ] Consider adding a pre-update health check to prevent rolling forward to broken versions
- [ ] Report upstream: `StandardInPath` omission in `openclaw gateway install`
- [ ] Report upstream: `gateway run` regression in 2026.3.28
