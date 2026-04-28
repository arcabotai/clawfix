# Diagnostic Playbook: Gateway Not Starting After Update

Use this playbook when the OpenClaw gateway is not responding after a version update, especially when:
- `openclaw gateway health` returns `gateway closed (1006)`
- `openclaw gateway status` shows `Runtime: running` but `RPC probe: failed`
- The watchdog log shows repeated `Gateway DOWN -- attempting recovery / Gateway FAILED TO RECOVER`

---

## Step 1: Gather initial state

```bash
# Check overall status
openclaw gateway status

# Check health endpoint directly
curl -s http://localhost:18789/health

# Check if the process is running
pgrep -fl "openclaw.*gateway"

# Check if port is listening
lsof -i :18789

# Check launchd service state
launchctl list | grep openclaw.gateway
```

**Key signals:**
- Process running + port NOT listening = startup hang or silent crash
- Process NOT running + launchd shows exit code = process dying on startup
- Exit code -15 in launchctl = killed by SIGTERM (launchd restarting it)
- Exit code 0 in launchctl = clean exit (command not starting server)

---

## Step 2: Check logs

```bash
# Gateway application log
tail -30 ~/.openclaw/logs/gateway.log

# Gateway error log
tail -30 ~/.openclaw/logs/gateway.err.log

# Watchdog log
tail -30 ~/.openclaw/logs/watchdog.log

# Structured log (new versions)
tail -5 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        ts = d.get('time','')
        msg = str(d.get('1',''))[:120] if d.get('1') else str(d.get('0',''))[:120]
        print(f'{ts} {msg}')
    except: pass
"

# Check restart sentinel (post-update state)
cat ~/.openclaw/restart-sentinel.json
```

**What to look for:**
- `shutdown timed out; exiting without full cleanup` = startup hang
- `Gateway start blocked: set gateway.mode=local` = config issue
- `plugin id mismatch` warnings (many) = version mismatch between config and binary
- Repeated SIGTERM entries = crash loop
- Empty logs despite process running = stdin hang (see Step 4)

---

## Step 3: Test manual startup

```bash
# Kill existing processes
pkill -f "openclaw.*gateway"
launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null
sleep 2

# Test 1: Run from terminal (interactive)
openclaw gateway --port 18789 --verbose
# Expected: Should show banner, plugin loading, then "listening on ws://..."

# Test 2: Run with explicit /dev/null stdin
openclaw gateway --port 18789 < /dev/null > /tmp/gw-test.log 2>&1 &
sleep 10
curl -s http://localhost:18789/health
# If this works but Test 1 via launchd doesn't: stdin hang issue

# Test 3: Run with nohup
nohup openclaw gateway --port 18789 > ~/.openclaw/logs/gateway.log 2>&1 &
sleep 10
curl -s http://localhost:18789/health
```

---

## Step 4: Diagnose stdin hang (launchd-specific)

**Symptom:** Gateway process is alive but produces zero log output and never binds to port.

```bash
# Check if plist has StandardInPath
grep -A1 "StandardInPath" ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# If missing, that's the bug. Fix:
# 1. Stop the service
launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null

# 2. Add StandardInPath to the plist (before StandardOutPath)
# Insert this XML block:
#   <key>StandardInPath</key>
#   <string>/dev/null</string>

# 3. Reload
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# 4. Verify
sleep 10
curl -s http://localhost:18789/health
```

---

## Step 5: Diagnose version-specific bugs

```bash
# Check current version
openclaw --version

# Known broken versions:
# - 2026.3.28: gateway/gateway run prints banner and exits 0 (doesn't start server)
# - 2026.3.24: same bug as 2026.3.28
# - 2026.3.13: works correctly

# If on a broken version, roll back:
npm i -g openclaw@2026.3.13 --no-fund --no-audit
openclaw gateway install --force
# Then apply the StandardInPath fix from Step 4
```

---

## Step 6: Check for configuration issues

```bash
# Verify gateway mode
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$HOME/.openclaw/openclaw.json', 'utf8'));
console.log('mode:', cfg.gateway?.mode);
console.log('port:', cfg.gateway?.port);
console.log('bind:', cfg.gateway?.bind);
console.log('tailscale:', cfg.gateway?.tailscale?.mode);
"

# gateway.mode MUST be "local" for the gateway to start
# If tailscale.mode is "serve" but tailscale is not installed, it may hang
which tailscale || echo "Tailscale not installed -- set tailscale.mode to off if gateway hangs"
```

---

## Step 7: Check for port conflicts

```bash
lsof -i :18789
# If another process is using the port, kill it or change the gateway port
```

---

## Step 8: Nuclear option (full reset)

If nothing else works:

```bash
# 1. Kill everything
pkill -f "openclaw.*gateway"
launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null
rm ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# 2. Roll back to known good version
npm i -g openclaw@2026.3.13 --no-fund --no-audit

# 3. Reinstall the service
openclaw gateway install --force

# 4. Patch the plist (add StandardInPath)
# Use the fix script from scripts/fix-launchd-stdin.sh

# 5. Start
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# 6. Verify
sleep 10
openclaw gateway health
```
