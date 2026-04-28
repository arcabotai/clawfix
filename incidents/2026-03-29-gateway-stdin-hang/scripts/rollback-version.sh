#!/bin/bash
# rollback-version.sh
# Rolls back OpenClaw to a known working version and restarts the gateway.
# Includes the StandardInPath fix for the plist.
#
# Usage: bash rollback-version.sh [version]
# Default version: 2026.3.13 (last known fully working version)

set -euo pipefail

TARGET_VERSION="${1:-2026.3.13}"
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"

echo "ClawFix: Rolling back OpenClaw to v$TARGET_VERSION"
echo "=================================================="

# Get current version
CURRENT=$(openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
echo "Current version: $CURRENT"
echo "Target version:  $TARGET_VERSION"

if [ "$CURRENT" = "$TARGET_VERSION" ]; then
  echo "Already on target version. Skipping install."
else
  # Stop gateway
  echo ""
  echo "Step 1: Stopping gateway..."
  pkill -f "openclaw.*gateway" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
  sleep 2

  # Install target version
  echo ""
  echo "Step 2: Installing openclaw@$TARGET_VERSION..."
  npm i -g "openclaw@$TARGET_VERSION" --no-fund --no-audit 2>&1

  # Verify
  INSTALLED=$(openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
  echo "Installed version: $INSTALLED"
  if [ "$INSTALLED" != "$TARGET_VERSION" ]; then
    echo "ERROR: Version mismatch after install. Expected $TARGET_VERSION, got $INSTALLED"
    exit 1
  fi
fi

# Reinstall plist
echo ""
echo "Step 3: Reinstalling LaunchAgent plist..."
openclaw gateway install --force 2>&1

# Apply stdin fix
echo ""
echo "Step 4: Applying StandardInPath fix..."
if ! grep -q "StandardInPath" "$PLIST" 2>/dev/null; then
  python3 -c "
with open('$PLIST', 'r') as f:
    content = f.read()
insertion = '    <key>StandardInPath</key>\n    <string>/dev/null</string>\n    '
content = content.replace('<key>StandardOutPath</key>', insertion + '<key>StandardOutPath</key>')
with open('$PLIST', 'w') as f:
    f.write(content)
"
  echo "Patched: Added StandardInPath=/dev/null"
else
  echo "Already has StandardInPath -- skipping"
fi

# Start
echo ""
echo "Step 5: Starting gateway..."
launchctl load "$PLIST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
echo "Waiting for startup..."

# Poll for health
for i in $(seq 1 12); do
  sleep 5
  HEALTH=$(curl -s -m 3 http://localhost:18789/health 2>/dev/null || true)
  if echo "$HEALTH" | grep -q '"ok":true'; then
    echo ""
    echo "SUCCESS: Gateway is healthy on v$TARGET_VERSION!"
    echo "$HEALTH"
    echo ""
    openclaw gateway health 2>/dev/null || true
    exit 0
  fi
  echo "  [$((i*5))s] waiting..."
done

echo ""
echo "WARNING: Gateway did not become healthy within 60 seconds."
echo "Check logs:"
echo "  tail -20 ~/.openclaw/logs/gateway.log"
echo "  tail -20 ~/.openclaw/logs/gateway.err.log"
exit 1
