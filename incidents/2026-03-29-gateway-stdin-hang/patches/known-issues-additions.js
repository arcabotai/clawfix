/**
 * New known issue patterns to add to src/known-issues.js
 * These were discovered during the 2026-03-29 gateway incident.
 *
 * Add these entries to the KNOWN_ISSUES array in src/known-issues.js
 */

// --- ISSUE 1: LaunchAgent missing StandardInPath ---
// Add after the existing 'launchd-corrupted-state' entry

const launchdStdinHang = {
  id: 'launchd-missing-stdin-path',
  severity: 'critical',
  title: 'LaunchAgent missing StandardInPath (gateway hangs on startup)',
  description:
    'The gateway LaunchAgent plist does not include StandardInPath=/dev/null. ' +
    'When launchd spawns the Node.js process without a TTY, the process hangs during ' +
    'CLI initialization because stdin is in an undefined state. The gateway process ' +
    'appears running but never binds to its port and produces zero log output. ' +
    'This is especially triggered after updates that cause a gateway restart. ' +
    'The `openclaw gateway install` command does not add this directive by default.',
  detect: (diag) => {
    // Detect: process running + port not listening + plist exists but no StandardInPath
    if (diag.os !== 'darwin') return false;
    const plistContent = diag.launchAgentPlist || diag.plist_content || '';
    const hasStdinPath = plistContent.includes('StandardInPath');
    const processRunning = diag.gatewayPid || diag.gateway_pid;
    const portListening = diag.gatewayListening || diag.gateway_listening;
    // If plist exists but no StandardInPath, it's vulnerable
    if (plistContent && !hasStdinPath) return true;
    // If process is running but port is not listening AND no StandardInPath, it's active
    if (processRunning && !portListening && !hasStdinPath) return true;
    return false;
  },
  fix: `#!/bin/bash
# Fix: Add StandardInPath=/dev/null to the gateway LaunchAgent plist
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"

if [ ! -f "$PLIST" ]; then
  echo "Plist not found. Run: openclaw gateway install"
  exit 1
fi

if grep -q "StandardInPath" "$PLIST"; then
  echo "Already fixed."
  exit 0
fi

# Backup
cp "$PLIST" "$PLIST.bak.$(date +%s)"

# Stop service
launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
sleep 2

# Patch: insert StandardInPath before StandardOutPath
python3 -c "
with open('$PLIST', 'r') as f:
    content = f.read()
insertion = '    <key>StandardInPath</key>\\n    <string>/dev/null</string>\\n    '
content = content.replace('<key>StandardOutPath</key>', insertion + '<key>StandardOutPath</key>')
with open('$PLIST', 'w') as f:
    f.write(content)
"

# Reload
launchctl load "$PLIST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null
echo "Patched and reloaded. Verify: curl http://localhost:18789/health"
`,
};

// --- ISSUE 2: Gateway run command broken in v2026.3.28 ---

const gatewayRunBroken = {
  id: 'gateway-run-broken-v2026.3.28',
  severity: 'critical',
  title: 'Gateway server does not start on v2026.3.28 (exits 0 immediately)',
  description:
    'OpenClaw version 2026.3.28 (both latest and beta npm tags as of 2026-03-29) has a regression ' +
    'where the `gateway` and `gateway run` CLI commands print the version banner and exit with code 0 ' +
    'without starting the WebSocket server. This affects all execution contexts (terminal, launchd, nohup). ' +
    'The same bug is present in 2026.3.24. Version 2026.3.13 is the last confirmed working version. ' +
    'The root cause appears to be a CLI routing change in the run-main module where the gateway command ' +
    'is no longer dispatched to the server start function.',
  detect: (diag) => {
    const version = diag.openclawVersion || diag.openclaw_version || '';
    // Known affected versions
    const affectedVersions = ['2026.3.28', '2026.3.24'];
    const isAffected = affectedVersions.some((v) => version.includes(v));
    // Only flag if gateway is not running
    const gatewayHealthy = diag.gatewayHealthy || diag.gateway_healthy;
    return isAffected && !gatewayHealthy;
  },
  fix: `#!/bin/bash
# Fix: Roll back to OpenClaw 2026.3.13 (last working version)
set -euo pipefail

echo "Rolling back to openclaw@2026.3.13..."

# Stop gateway
pkill -f "openclaw.*gateway" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
sleep 2

# Install working version
npm i -g openclaw@2026.3.13 --no-fund --no-audit

# Reinstall plist
openclaw gateway install --force 2>/dev/null

# Apply stdin fix
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
if [ -f "$PLIST" ] && ! grep -q "StandardInPath" "$PLIST"; then
  python3 -c "
with open('$PLIST', 'r') as f:
    content = f.read()
insertion = '    <key>StandardInPath</key>\\n    <string>/dev/null</string>\\n    '
content = content.replace('<key>StandardOutPath</key>', insertion + '<key>StandardOutPath</key>')
with open('$PLIST', 'w') as f:
    f.write(content)
"
fi

# Start
launchctl load "$PLIST" 2>/dev/null || true
echo "Rolled back. Verify: curl http://localhost:18789/health"
`,
};

// --- ISSUE 3: Plugin id mismatch spam (v2026.3.28) ---

const pluginIdMismatchSpam = {
  id: 'plugin-id-mismatch-spam',
  severity: 'medium',
  title: 'Plugin id mismatch warnings flooding error log (v2026.3.28)',
  description:
    'Version 2026.3.28 logs a warning for every bundled plugin: ' +
    '"plugin <name>: plugin id mismatch (manifest uses <x>, entry hints <y>)". ' +
    'This generates 40+ warning lines on every startup, filling the error log. ' +
    'While not directly causing crashes, it obscures real errors and indicates ' +
    'an internal inconsistency in the plugin manifest/entry resolution.',
  detect: (diag) => {
    const errLog = diag.gatewayErrLog || diag.gateway_err_log || '';
    const mismatchCount = (errLog.match(/plugin id mismatch/g) || []).length;
    return mismatchCount > 10;
  },
  fix: `# This is a cosmetic issue in v2026.3.28. The fix is to roll back to 2026.3.13:
# npm i -g openclaw@2026.3.13 --no-fund --no-audit
# Or wait for a patched version.
echo "This issue is cosmetic. Consider rolling back to 2026.3.13 if it bothers you."
`,
};

// --- ISSUE 4: Post-update restart failure ---

const postUpdateRestartFailure = {
  id: 'post-update-restart-failure',
  severity: 'high',
  title: 'Gateway failed to restart after self-update',
  description:
    'The gateway triggered a self-update (via Discord command or auto-update) which succeeded ' +
    'in installing the new version, but the subsequent restart failed. The restart sentinel file ' +
    'shows a successful update but the gateway never came back online. This commonly happens when: ' +
    '(1) the new version has a startup bug, (2) the LaunchAgent plist is incompatible with the new version, ' +
    'or (3) the stdin hang bug prevents the restarted process from initializing.',
  detect: (diag) => {
    const sentinel = diag.restartSentinel || diag.restart_sentinel || '';
    const gatewayHealthy = diag.gatewayHealthy || diag.gateway_healthy;
    // Sentinel exists with "kind":"update" and "status":"ok" but gateway is not healthy
    if (sentinel.includes('"kind":"update"') && sentinel.includes('"status":"ok"') && !gatewayHealthy) {
      return true;
    }
    return false;
  },
  fix: `#!/bin/bash
# Fix: Recover from a failed post-update restart
set -euo pipefail

echo "Recovering from failed post-update restart..."

# Check restart sentinel for version info
if [ -f "$HOME/.openclaw/restart-sentinel.json" ]; then
  BEFORE=$(python3 -c "import json; d=json.load(open('$HOME/.openclaw/restart-sentinel.json')); print(d.get('payload',{}).get('stats',{}).get('before',{}).get('version','unknown'))" 2>/dev/null || echo "unknown")
  AFTER=$(python3 -c "import json; d=json.load(open('$HOME/.openclaw/restart-sentinel.json')); print(d.get('payload',{}).get('stats',{}).get('after',{}).get('version','unknown'))" 2>/dev/null || echo "unknown")
  echo "Update was: $BEFORE -> $AFTER"
  echo "Rolling back to: $BEFORE"
  TARGET="$BEFORE"
else
  echo "No restart sentinel found. Rolling back to 2026.3.13."
  TARGET="2026.3.13"
fi

# Stop everything
pkill -f "openclaw.*gateway" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
sleep 2

# Rollback
npm i -g "openclaw@$TARGET" --no-fund --no-audit

# Reinstall and fix plist
openclaw gateway install --force 2>/dev/null
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
if [ -f "$PLIST" ] && ! grep -q "StandardInPath" "$PLIST"; then
  python3 -c "
with open('$PLIST', 'r') as f:
    content = f.read()
insertion = '    <key>StandardInPath</key>\\n    <string>/dev/null</string>\\n    '
content = content.replace('<key>StandardOutPath</key>', insertion + '<key>StandardOutPath</key>')
with open('$PLIST', 'w') as f:
    f.write(content)
"
fi

# Start
launchctl load "$PLIST" 2>/dev/null || true
echo "Rolled back to $TARGET. Verify: curl http://localhost:18789/health"
`,
};

export { launchdStdinHang, gatewayRunBroken, pluginIdMismatchSpam, postUpdateRestartFailure };
