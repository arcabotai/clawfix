# System Prompt Additions for src/routes/diagnose.js

Add these real-world crash scenarios to the `SYSTEM_PROMPT` string in `src/routes/diagnose.js` (around line 30-98 where existing scenarios are documented).

---

## New scenarios to add:

```
### LaunchAgent stdin hang (macOS)
When the gateway LaunchAgent plist does not include StandardInPath=/dev/null, the Node.js
process may hang during CLI initialization because launchd does not provide a TTY on stdin.
Symptoms: process running (visible in ps/launchctl) but port not listening, zero log output,
health endpoint unreachable. The watchdog cannot fix this because launchctl reload also fails.
Fix: Add <key>StandardInPath</key><string>/dev/null</string> to the plist before StandardOutPath.
This is especially triggered after self-updates that cause a SIGUSR1 restart.

### Gateway command exits 0 without starting server (v2026.3.28 regression)
OpenClaw versions 2026.3.28 and 2026.3.24 have a regression where the "gateway" and
"gateway run" CLI commands print the version banner and exit with code 0 without starting
the WebSocket server. This affects ALL execution contexts (terminal, launchd, nohup).
Version 2026.3.13 is the last confirmed working version. The root cause is a CLI routing
change in the run-main module. Fix: roll back to 2026.3.13 with
npm i -g openclaw@2026.3.13.

### Post-update restart failure cascade
When the agent triggers a self-update (via Discord command or auto-update), the update
may succeed but the subsequent restart fails. The restart sentinel shows status:"ok" but
the gateway never comes back online. This creates a cascade: (1) watchdog detects DOWN,
(2) watchdog tries launchctl reload but gets I/O error, (3) backup files accumulate in
~/Backups/openclaw-migrations/. Fix: roll back to the version in
restart-sentinel.json -> payload.stats.before.version.

### Plugin id mismatch warnings (v2026.3.28)
Version 2026.3.28 logs warnings for every bundled plugin like "plugin anthropic: plugin
id mismatch (manifest uses 'anthropic', entry hints 'anthropic-provider')". This generates
40+ warning lines per startup, filling the error log. While cosmetic, it can obscure real
errors and indicates the version has internal inconsistencies.

### Tailscale config mismatch
If gateway.tailscale.mode is set to "serve" or "funnel" but the tailscale binary is not
installed on the system, the gateway may hang during startup trying to set up Tailscale
exposure. Fix: set gateway.tailscale.mode to "off" in openclaw.json, or install Tailscale.
```
