#!/bin/bash
# diagnostic-script-additions.sh
#
# New diagnostic checks to add to the bash diagnostic script in src/routes/script.js
# These should be integrated into the collect_gateway_info() or equivalent section.
#
# Add these checks to the diagnostic payload collection.

# ============================================================
# CHECK 1: StandardInPath in LaunchAgent plist
# ============================================================
# Add to the section that checks the LaunchAgent plist

check_plist_stdin_path() {
  local PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
  local HAS_STDIN_PATH="false"
  local PLIST_CONTENT=""

  if [ -f "$PLIST" ]; then
    PLIST_CONTENT=$(cat "$PLIST" 2>/dev/null | head -100)
    if echo "$PLIST_CONTENT" | grep -q "StandardInPath"; then
      HAS_STDIN_PATH="true"
    fi
  fi

  # Add to the diagnostic JSON payload:
  # "plist_has_stdin_path": "$HAS_STDIN_PATH",
  # "plist_content": "$(echo "$PLIST_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ')",
  echo "$HAS_STDIN_PATH"
}

# ============================================================
# CHECK 2: Gateway process running but not listening (zombie-like)
# ============================================================

check_gateway_process_vs_port() {
  local GW_PID=$(pgrep -f "openclaw.*gateway" 2>/dev/null | head -1)
  local PORT_LISTENING="false"

  if [ -n "$GW_PID" ]; then
    if lsof -i :18789 2>/dev/null | grep -q LISTEN; then
      PORT_LISTENING="true"
    fi
  fi

  # Add to the diagnostic JSON payload:
  # "gateway_pid": "$GW_PID",
  # "gateway_listening": $PORT_LISTENING,
  # "gateway_stdin_hang_suspected": $([ -n "$GW_PID" ] && [ "$PORT_LISTENING" = "false" ] && echo "true" || echo "false"),
  echo "pid=$GW_PID listening=$PORT_LISTENING"
}

# ============================================================
# CHECK 3: Restart sentinel state (post-update status)
# ============================================================

check_restart_sentinel() {
  local SENTINEL="$HOME/.openclaw/restart-sentinel.json"
  local SENTINEL_CONTENT=""
  local UPDATE_STATUS="none"
  local BEFORE_VERSION=""
  local AFTER_VERSION=""

  if [ -f "$SENTINEL" ]; then
    SENTINEL_CONTENT=$(cat "$SENTINEL" 2>/dev/null)
    UPDATE_STATUS=$(echo "$SENTINEL_CONTENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('payload',{}).get('status','unknown'))" 2>/dev/null || echo "unknown")
    BEFORE_VERSION=$(echo "$SENTINEL_CONTENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('payload',{}).get('stats',{}).get('before',{}).get('version','unknown'))" 2>/dev/null || echo "unknown")
    AFTER_VERSION=$(echo "$SENTINEL_CONTENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('payload',{}).get('stats',{}).get('after',{}).get('version','unknown'))" 2>/dev/null || echo "unknown")
  fi

  # Add to the diagnostic JSON payload:
  # "restart_sentinel": "$(echo "$SENTINEL_CONTENT" | sed 's/"/\\"/g' | tr '\n' ' ')",
  # "update_status": "$UPDATE_STATUS",
  # "update_before_version": "$BEFORE_VERSION",
  # "update_after_version": "$AFTER_VERSION",
  echo "status=$UPDATE_STATUS before=$BEFORE_VERSION after=$AFTER_VERSION"
}

# ============================================================
# CHECK 4: Known broken version detection
# ============================================================

check_known_broken_versions() {
  local VERSION=$(openclaw --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
  local IS_BROKEN="false"

  # Known broken versions where gateway command doesn't start the server
  case "$VERSION" in
    2026.3.28|2026.3.24)
      IS_BROKEN="true"
      ;;
  esac

  # Add to the diagnostic JSON payload:
  # "openclaw_version": "$VERSION",
  # "version_known_broken": $IS_BROKEN,
  echo "version=$VERSION broken=$IS_BROKEN"
}

# ============================================================
# CHECK 5: Watchdog failure pattern detection
# ============================================================

check_watchdog_failure_loop() {
  local WATCHDOG_LOG="$HOME/.openclaw/logs/watchdog.log"
  local CONSECUTIVE_FAILURES=0

  if [ -f "$WATCHDOG_LOG" ]; then
    # Count consecutive FAILED TO RECOVER at end of log
    CONSECUTIVE_FAILURES=$(tail -100 "$WATCHDOG_LOG" | tac | awk '/FAILED TO RECOVER/{count++; next}{exit} END{print count}')
  fi

  # Add to the diagnostic JSON payload:
  # "watchdog_consecutive_failures": $CONSECUTIVE_FAILURES,
  # "watchdog_in_failure_loop": $([ "$CONSECUTIVE_FAILURES" -gt 5 ] && echo "true" || echo "false"),
  echo "consecutive_failures=$CONSECUTIVE_FAILURES"
}

# ============================================================
# CHECK 6: Tailscale availability (config says serve but binary missing)
# ============================================================

check_tailscale_config_mismatch() {
  local TAILSCALE_MODE=$(python3 -c "import json; c=json.load(open('$HOME/.openclaw/openclaw.json')); print(c.get('gateway',{}).get('tailscale',{}).get('mode','off'))" 2>/dev/null || echo "unknown")
  local TAILSCALE_INSTALLED="false"

  if command -v tailscale >/dev/null 2>&1; then
    TAILSCALE_INSTALLED="true"
  fi

  # Add to the diagnostic JSON payload:
  # "tailscale_config_mode": "$TAILSCALE_MODE",
  # "tailscale_installed": $TAILSCALE_INSTALLED,
  # "tailscale_config_mismatch": $([ "$TAILSCALE_MODE" != "off" ] && [ "$TAILSCALE_INSTALLED" = "false" ] && echo "true" || echo "false"),
  echo "mode=$TAILSCALE_MODE installed=$TAILSCALE_INSTALLED"
}
