#!/bin/bash
# fix-launchd-stdin.sh
# Fixes the OpenClaw gateway LaunchAgent by adding StandardInPath=/dev/null
# This prevents the Node.js process from hanging on stdin when launched by launchd.
#
# Usage: bash fix-launchd-stdin.sh
# Safe to run multiple times (idempotent).

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
BACKUP="$PLIST.bak.$(date +%s)"

echo "ClawFix: Fixing LaunchAgent stdin hang"
echo "======================================="

# Check if plist exists
if [ ! -f "$PLIST" ]; then
  echo "ERROR: LaunchAgent plist not found at $PLIST"
  echo "Run 'openclaw gateway install' first."
  exit 1
fi

# Check if already fixed
if grep -q "StandardInPath" "$PLIST" 2>/dev/null; then
  echo "OK: StandardInPath already present in plist. No action needed."
  exit 0
fi

# Backup
cp "$PLIST" "$BACKUP"
echo "Backup: $BACKUP"

# Check if service is running
SERVICE_RUNNING=false
if launchctl list 2>/dev/null | grep -q "ai.openclaw.gateway"; then
  SERVICE_RUNNING=true
  echo "Stopping gateway service..."
  launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
  sleep 2
fi

# Insert StandardInPath before StandardOutPath
if grep -q "StandardOutPath" "$PLIST"; then
  # Use python3 for reliable XML manipulation (available on all macOS)
  python3 -c "
import re
with open('$PLIST', 'r') as f:
    content = f.read()

# Insert StandardInPath before StandardOutPath
insertion = '    <key>StandardInPath</key>\n    <string>/dev/null</string>\n    '
content = content.replace(
    '<key>StandardOutPath</key>',
    insertion + '<key>StandardOutPath</key>'
)

with open('$PLIST', 'w') as f:
    f.write(content)
"
  echo "Patched: Added StandardInPath=/dev/null"
else
  echo "ERROR: Could not find StandardOutPath in plist to insert before."
  echo "Manual fix needed. Add this before </dict>:"
  echo '    <key>StandardInPath</key>'
  echo '    <string>/dev/null</string>'
  cp "$BACKUP" "$PLIST"
  exit 1
fi

# Verify the patch
if grep -q "StandardInPath" "$PLIST"; then
  echo "Verified: StandardInPath present in plist"
else
  echo "ERROR: Patch verification failed. Restoring backup."
  cp "$BACKUP" "$PLIST"
  exit 1
fi

# Reload if it was running
if [ "$SERVICE_RUNNING" = true ]; then
  echo "Reloading gateway service..."
  launchctl load "$PLIST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  echo "Waiting for startup..."
  sleep 10

  # Verify health
  HEALTH=$(curl -s -m 5 http://localhost:18789/health 2>/dev/null || true)
  if echo "$HEALTH" | grep -q '"ok":true'; then
    echo "SUCCESS: Gateway is healthy!"
    echo "$HEALTH"
  else
    echo "WARNING: Gateway may still be starting. Check in a few seconds:"
    echo "  curl http://localhost:18789/health"
  fi
else
  echo "Service was not running. Start with:"
  echo "  launchctl load $PLIST"
fi

echo ""
echo "Done. Backup saved at: $BACKUP"
