import { Router } from 'express';
import { createHash } from 'node:crypto';

export const scriptRouter = Router();

// Serve the diagnostic script for download, review, and local execution.
scriptRouter.get('/fix', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('X-Script-SHA256', SCRIPT_HASH);
  res.send(DIAGNOSTIC_SCRIPT);
});

// Script hash endpoint for verification
scriptRouter.get('/fix/sha256', (req, res) => {
  res.json({
    sha256: SCRIPT_HASH,
    verify: 'curl --fail --show-error --silent --location https://clawfix.dev/fix --output clawfix.sh && shasum -a 256 clawfix.sh',
    note: 'Compare the printed hashes exactly before running the script. GitHub reference: https://github.com/arcabotai/clawfix/blob/main/SCRIPT_HASH',
  });
});

const DIAGNOSTIC_SCRIPT = `#!/usr/bin/env bash
# ClawFix: OpenClaw diagnostics and guarded repairs
# https://clawfix.dev
# 
# WHAT THIS SCRIPT DOES:
#   1. Checks your OpenClaw installation (config, logs, plugins, ports)
#   2. Detects common issues via pattern matching
#   3. Optionally sends diagnostic data with recognized secrets redacted (asks first)
#
# WHAT THIS SCRIPT DOES NOT DO:
#   ✗ Modify any files
#   ✗ Send data without your explicit approval
#   ✗ Read workspace document contents (only checks existence and counts)
#   ✗ Send your real hostname (SHA-256 hashed)
#   The top-level config env block is omitted; recognized secrets elsewhere are redacted.
#
# VERIFY THIS SCRIPT:
#   curl --fail --show-error --silent --location https://clawfix.dev/fix --output clawfix.sh
#   cat clawfix.sh
#   shasum -a 256 clawfix.sh
#   curl --fail --show-error --silent https://clawfix.dev/fix/sha256
#   Compare the printed hashes exactly before running the script.
#   bash clawfix.sh
#
# PREFER NPX (auditable source on npm/GitHub):
#   npx clawfix                 # Interactive scan
#   npx clawfix --dry-run       # See what data would be collected
#
# Source code: https://github.com/arcabotai/clawfix

set -euo pipefail

# --- Config ---
API_URL="\${CLAWFIX_API:-https://clawfix.dev}"
VERSION="0.11.0"

# --- Colors ---
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
CYAN='\\033[0;36m'
NC='\\033[0m'
BOLD='\\033[1m'

echo ""
echo -e "\${CYAN}🦞 ClawFix v\${VERSION}: OpenClaw Diagnostics and Guarded Repairs\${NC}"
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

# --- Check dependencies ---
for cmd in node npm jq curl; do
  if ! command -v "\$cmd" &>/dev/null; then
    echo -e "\${RED}❌ Missing: \$cmd\${NC}"
    echo "Please install \$cmd and try again."
    exit 1
  fi
done

# --- Detect OpenClaw ---
OPENCLAW_BIN=""
OPENCLAW_DIR=""
OPENCLAW_CONFIG=""

# Find openclaw binary
if command -v openclaw &>/dev/null; then
  OPENCLAW_BIN=\$(which openclaw)
elif [ -f "/opt/homebrew/bin/openclaw" ]; then
  OPENCLAW_BIN="/opt/homebrew/bin/openclaw"
elif [ -f "/usr/local/bin/openclaw" ]; then
  OPENCLAW_BIN="/usr/local/bin/openclaw"
fi

# Find config directory
if [ -d "\$HOME/.openclaw" ]; then
  OPENCLAW_DIR="\$HOME/.openclaw"
elif [ -d "\$HOME/.config/openclaw" ]; then
  OPENCLAW_DIR="\$HOME/.config/openclaw"
fi

# Find config file
if [ -n "\$OPENCLAW_DIR" ] && [ -f "\$OPENCLAW_DIR/openclaw.json" ]; then
  OPENCLAW_CONFIG="\$OPENCLAW_DIR/openclaw.json"
fi

if [ -z "\$OPENCLAW_BIN" ] && [ -z "\$OPENCLAW_DIR" ]; then
  echo -e "\${RED}❌ OpenClaw not found on this system.\${NC}"
  echo "Make sure OpenClaw is installed: https://openclaw.ai"
  exit 1
fi

echo -e "\${GREEN}✅ OpenClaw found\${NC}"
[ -n "\$OPENCLAW_BIN" ] && echo "   Binary: \$OPENCLAW_BIN"
[ -n "\$OPENCLAW_DIR" ] && echo "   Config: \$OPENCLAW_DIR"

# --- Collect System Info ---
echo ""
echo -e "\${BLUE}📋 Collecting system information...\${NC}"

OS_NAME=\$(uname -s)
OS_VERSION=\$(uname -r)
OS_ARCH=\$(uname -m)
NODE_VERSION=\$(node --version 2>/dev/null || echo "unknown")
NPM_VERSION=\$(npm --version 2>/dev/null || echo "unknown")
HOSTNAME_HASH=\$(hostname | shasum -a 256 | cut -c1-8)

# OpenClaw version
OC_VERSION=""
if [ -n "\$OPENCLAW_BIN" ]; then
  OC_VERSION=\$("\$OPENCLAW_BIN" --version 2>/dev/null || echo "unknown")
fi

echo -e "   OS: \$OS_NAME \$OS_VERSION (\$OS_ARCH)"
echo -e "   Node: \$NODE_VERSION"
echo -e "   OpenClaw: \${OC_VERSION:-not found}"

# --- Sanitize Config (REDACT RECOGNIZED SECRETS) ---
echo ""
echo -e "\${BLUE}🔒 Reading config (recognized secrets will be redacted)...\${NC}"

SANITIZED_CONFIG="{}"
CONFIG_EXISTS=false
if [ -n "\$OPENCLAW_CONFIG" ]; then
  CONFIG_EXISTS=true
  # Redact anything that looks like a key, token, secret, or password
  SANITIZED_CONFIG=\$(jq '
    walk(
      if type == "string" then
        if (length > 20 and (test("^(sk-|xai-|eyJ|ghp_|gho_|npm_|m0-|AIza|ntn_)") or test("^[A-Za-z0-9+/=]{40,}$"))) then
          "***REDACTED***"
        elif (length > 8 and test("(key|token|secret|password|jwt|apiKey|accessToken)"; "i")) then
          "***REDACTED***"
        else .
        end
      else .
      end
    )
    | del(.env)
    | if .gateway.auth then .gateway.auth.token = "***REDACTED***" else . end
    | if .channels then (.channels | to_entries | map(.value.accessToken = "***REDACTED***" | .value.apiKey = "***REDACTED***") | from_entries) as \$ch | .channels = \$ch else . end
  ' "\$OPENCLAW_CONFIG" 2>/dev/null || echo '{"error": "could not parse config"}')
  
  echo -e "\${GREEN}   ✅ Config read and sanitized\${NC}"
else
  echo -e "\${YELLOW}   ⚠️  No config file found\${NC}"
fi

# --- Check Gateway Status ---
echo ""
echo -e "\${BLUE}🔌 Checking gateway status...\${NC}"

GATEWAY_STATUS="unknown"
GATEWAY_PID=""
GATEWAY_PORT=""

if [ -n "\$OPENCLAW_BIN" ]; then
  GATEWAY_STATUS=\$("\$OPENCLAW_BIN" gateway status 2>&1 || echo "error")
fi

# Try to find gateway process
GATEWAY_PID=\$(pgrep -f "openclaw.*gateway" 2>/dev/null | head -1 || echo "")

# Try to detect port from config
if [ -n "\$OPENCLAW_CONFIG" ]; then
  GATEWAY_PORT=\$(jq -r '.gateway.port // 18789' "\$OPENCLAW_CONFIG" 2>/dev/null || echo "18789")
fi

# Check if port is actually listening (process may exist but be zombie/shutdown)
PORT_LISTENING=false
PROCESS_EXISTS=false
[ -n "\$GATEWAY_PID" ] && PROCESS_EXISTS=true
if lsof -i ":\${GATEWAY_PORT:-18789}" &>/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ":\${GATEWAY_PORT:-18789} "; then
  PORT_LISTENING=true
fi

# --- Check Service Manager ---
echo ""
echo -e "\${BLUE}🔧 Checking service manager...\${NC}"

SERVICE_MANAGER="none"
SERVICE_STATE=""
SERVICE_EXIT_CODE=""
SERVICE_RUNS=""
SERVICE_PID=""

if [ "\$OS_NAME" = "Darwin" ]; then
  SERVICE_MANAGER="launchd"
  LAUNCHCTL_OUT=\$(launchctl list 2>/dev/null | grep -i openclaw || echo "")
  if [ -n "\$LAUNCHCTL_OUT" ]; then
    SERVICE_PID=\$(echo "\$LAUNCHCTL_OUT" | awk '{print \$1}')
    SERVICE_EXIT_CODE=\$(echo "\$LAUNCHCTL_OUT" | awk '{print \$2}')
    # Exit code -15 = SIGTERM, -1 = last run failed
    if [ "\$SERVICE_EXIT_CODE" = "-15" ]; then
      SERVICE_STATE="sigterm"
      echo -e "   \${RED}⚠️  Service received SIGTERM (exit -15) — possible crash loop or forced kill\${NC}"
    elif [ "\$SERVICE_EXIT_CODE" = "0" ] && [ "\$SERVICE_PID" != "-" ]; then
      SERVICE_STATE="running"
      echo -e "   \${GREEN}✅ launchd: running (pid \$SERVICE_PID)\${NC}"
    elif [ "\$SERVICE_PID" = "-" ] && [ "\$SERVICE_EXIT_CODE" != "0" ]; then
      SERVICE_STATE="crashed"
      echo -e "   \${RED}❌ launchd: not running (last exit: \$SERVICE_EXIT_CODE)\${NC}"
    else
      SERVICE_STATE="unknown"
      echo -e "   \${YELLOW}⚠️  launchd state unclear: \$LAUNCHCTL_OUT\${NC}"
    fi
    # Get ThrottleInterval / runs if plist exists
    PLIST_PATH="\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
    if [ -f "\$PLIST_PATH" ]; then
      SERVICE_RUNS=\$(defaults read "\$PLIST_PATH" ThrottleInterval 2>/dev/null || echo "")
      echo -e "   plist: \$PLIST_PATH"
    fi
  else
    SERVICE_STATE="not_registered"
    echo -e "   \${YELLOW}⚠️  No openclaw LaunchAgent found in launchctl\${NC}"
  fi
elif command -v systemctl &>/dev/null; then
  SERVICE_MANAGER="systemd"
  SYSTEMCTL_OUT=\$(systemctl status openclaw-gateway 2>/dev/null | head -10 || echo "")
  if echo "\$SYSTEMCTL_OUT" | grep -q "active (running)"; then
    SERVICE_STATE="running"
    echo -e "   \${GREEN}✅ systemd: active (running)\${NC}"
  elif echo "\$SYSTEMCTL_OUT" | grep -q "failed"; then
    SERVICE_STATE="failed"
    SERVICE_EXIT_CODE=\$(echo "\$SYSTEMCTL_OUT" | grep -oP 'status=\K[0-9/]+' || echo "?")
    echo -e "   \${RED}❌ systemd: failed (exit \$SERVICE_EXIT_CODE)\${NC}"
  elif echo "\$SYSTEMCTL_OUT" | grep -q "inactive"; then
    SERVICE_STATE="inactive"
    echo -e "   \${YELLOW}⚠️  systemd: inactive (stopped)\${NC}"
  fi
  SERVICE_RUNS=\$(systemctl show openclaw-gateway --property=NRestarts 2>/dev/null | cut -d= -f2 || echo "0")
else
  echo -e "   No service manager detected"
fi

echo -e "   Status: \$GATEWAY_STATUS"
[ -n "\$GATEWAY_PID" ] && echo -e "   PID: \$GATEWAY_PID (exists: \$PROCESS_EXISTS)"
echo -e "   Port: \${GATEWAY_PORT:-18789} (listening: \$PORT_LISTENING)"

# --- Check Logs ---
echo ""
echo -e "\${BLUE}📜 Reading recent logs...\${NC}"

GATEWAY_LOG=""
ERROR_LOG=""
SIGTERM_COUNT=0

if [ -f "\$OPENCLAW_DIR/logs/gateway.log" ]; then
  GATEWAY_LOG=\$(tail -100 "\$OPENCLAW_DIR/logs/gateway.log" 2>/dev/null | grep -i "error\\|warn\\|fail\\|crash\\|EADDRINUSE\\|EACCES" | tail -30 || echo "")
  echo -e "   \${GREEN}✅ Gateway log found (\$(wc -l < "\$OPENCLAW_DIR/logs/gateway.log" | tr -d ' ') lines)\${NC}"
fi

ERR_LOG_SIZE_MB=0
HANDSHAKE_TIMEOUT_COUNT=0
if [ -f "\$OPENCLAW_DIR/logs/gateway.err.log" ]; then
  ERROR_LOG=\$(tail -50 "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null || echo "")
  # Collect metrics about the error log
  ERR_LOG_SIZE_MB=\$(du -sm "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null | awk '{print \$1}' || echo "0")
  HANDSHAKE_TIMEOUT_COUNT=\$(grep -c "invalid handshake\\|closed before connect\\|chrome-extension.*timeout" "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null || echo "0")
  # Also scan for SIGTERM events in gateway log
  SIGTERM_COUNT=\$(grep -c "signal SIGTERM received\\|exit code -15" "\$OPENCLAW_DIR/logs/gateway.log" 2>/dev/null || echo "0")
  if [ "\$ERR_LOG_SIZE_MB" -gt 10 ]; then
    echo -e "   \${YELLOW}⚠️  Error log is \${ERR_LOG_SIZE_MB}MB (large — likely log spam)\${NC}"
  else
    echo -e "   \${GREEN}✅ Error log found (\${ERR_LOG_SIZE_MB}MB)\${NC}"
  fi
  [ "\$HANDSHAKE_TIMEOUT_COUNT" -gt 0 ] && echo -e "   \${YELLOW}⚠️  \$HANDSHAKE_TIMEOUT_COUNT handshake timeout lines (browser relay spam?)\${NC}"
  [ "\$SIGTERM_COUNT" -gt 0 ] && echo -e "   \${YELLOW}⚠️  \$SIGTERM_COUNT SIGTERM events in gateway log\${NC}"
fi

# --- Check Plugins ---
echo ""
echo -e "\${BLUE}🔌 Checking plugins...\${NC}"

PLUGINS_STATUS=""
if [ -n "\$OPENCLAW_CONFIG" ]; then
  PLUGINS_STATUS=\$(jq -r '
    .plugins.entries // {} | to_entries[] |
    "   " + (if .value.enabled == false then "❌" else "✅" end) + " " + .key
  ' "\$OPENCLAW_CONFIG" 2>/dev/null || echo "   Could not read plugins")
  echo "\$PLUGINS_STATUS"
fi

# --- Check Browser ---
echo ""
echo -e "\${BLUE}🌐 Checking browser setup...\${NC}"

BROWSER_DIR="\$OPENCLAW_DIR/browser"
BROWSER_STATUS="not configured"
if [ -d "\$BROWSER_DIR" ]; then
  BROWSER_STATUS="configured"
  [ -d "\$BROWSER_DIR/openclaw/user-data" ] && echo -e "   \${GREEN}✅ Managed browser profile found\${NC}"
  [ -d "\$BROWSER_DIR/chrome-extension" ] && echo -e "   \${GREEN}✅ Relay extension found\${NC}"
  [ -d "\$BROWSER_DIR/metamask-extension" ] && echo -e "   \${GREEN}✅ MetaMask extension found\${NC}"
fi

# --- Check Workspace ---
echo ""
echo -e "\${BLUE}📁 Checking workspace...\${NC}"

WORKSPACE_DIR=""
if [ -n "\$OPENCLAW_CONFIG" ]; then
  WORKSPACE_DIR=\$(jq -r '.agents.defaults.workspace // ""' "\$OPENCLAW_CONFIG" 2>/dev/null)
fi

WORKSPACE_FILES=0
MEMORY_FILES=0
SOUL_EXISTS=false
AGENTS_EXISTS=false

if [ -n "\$WORKSPACE_DIR" ] && [ -d "\$WORKSPACE_DIR" ]; then
  WORKSPACE_FILES=\$(find "\$WORKSPACE_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  [ -d "\$WORKSPACE_DIR/memory" ] && MEMORY_FILES=\$(ls "\$WORKSPACE_DIR/memory/"*.md 2>/dev/null | wc -l | tr -d ' ')
  [ -f "\$WORKSPACE_DIR/SOUL.md" ] && SOUL_EXISTS=true
  [ -f "\$WORKSPACE_DIR/AGENTS.md" ] && AGENTS_EXISTS=true
  
  echo -e "   Path: \$WORKSPACE_DIR"
  echo -e "   Files: \$WORKSPACE_FILES .md files"
  echo -e "   Memory: \$MEMORY_FILES daily notes"
  echo -e "   SOUL.md: \$SOUL_EXISTS"
  echo -e "   AGENTS.md: \$AGENTS_EXISTS"
fi

# --- Check Ports ---
echo ""
echo -e "\${BLUE}🔗 Checking port availability...\${NC}"

check_port() {
  local port=\$1
  local name=\$2
  if lsof -i ":\$port" &>/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ":\$port "; then
    echo -e "   \${YELLOW}⚠️  Port \$port (\$name) — IN USE\${NC}"
    return 1
  else
    echo -e "   \${GREEN}✅ Port \$port (\$name) — available\${NC}"
    return 0
  fi
}

check_port "\${GATEWAY_PORT:-18789}" "gateway"
check_port 18800 "browser CDP"
check_port 18791 "browser control"

# --- Build Diagnostic Payload ---
echo ""
echo -e "\${BLUE}📦 Building diagnostic report...\${NC}"

DIAGNOSTIC=\$(cat <<EOF
{
  "version": "\$VERSION",
  "timestamp": "\$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostHash": "\$HOSTNAME_HASH",
  "system": {
    "os": "\$OS_NAME",
    "osVersion": "\$OS_VERSION",
    "arch": "\$OS_ARCH",
    "nodeVersion": "\$NODE_VERSION",
    "npmVersion": "\$NPM_VERSION"
  },
  "openclaw": {
    "version": "\${OC_VERSION:-unknown}",
    "binary": "\${OPENCLAW_BIN:-not found}",
    "configDir": "\${OPENCLAW_DIR:-not found}",
    "configExists": \$CONFIG_EXISTS,
    "gatewayStatus": \$(echo "\$GATEWAY_STATUS" | jq -Rs .),
    "gatewayPid": "\${GATEWAY_PID:-none}",
    "gatewayPort": "\${GATEWAY_PORT:-18789}",
    "processExists": \$PROCESS_EXISTS,
    "portListening": \$PORT_LISTENING
  },
  "service": {
    "manager": "\$SERVICE_MANAGER",
    "state": "\${SERVICE_STATE:-unknown}",
    "exitCode": "\${SERVICE_EXIT_CODE:-}",
    "pid": "\${SERVICE_PID:-}",
    "runs": "\${SERVICE_RUNS:-}"
  },
  "config": \$SANITIZED_CONFIG,
  "logs": {
    "errors": \$(echo "\$GATEWAY_LOG" | jq -Rs .),
    "stderr": \$(echo "\$ERROR_LOG" | jq -Rs .),
    "errLogSizeMB": \${ERR_LOG_SIZE_MB:-0},
    "handshakeTimeoutCount": \${HANDSHAKE_TIMEOUT_COUNT:-0},
    "sigtermCount": \${SIGTERM_COUNT:-0}
  },
  "workspace": {
    "path": "\${WORKSPACE_DIR:-unknown}",
    "mdFiles": \$WORKSPACE_FILES,
    "memoryFiles": \$MEMORY_FILES,
    "hasSoul": \$SOUL_EXISTS,
    "hasAgents": \$AGENTS_EXISTS
  },
  "browser": {
    "status": "\$BROWSER_STATUS"
  }
}
EOF
)

# --- Show Summary ---
echo ""
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo -e "\${BOLD}📊 Diagnostic Summary\${NC}"
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

# Count issues
ISSUES=0
ISSUE_LIST=""

# Check for common problems
GATEWAY_RUNNING=false
if echo "\$GATEWAY_STATUS" | grep -qi "running.*pid\\|state active\\|listening"; then
  GATEWAY_RUNNING=true
fi
if echo "\$GATEWAY_STATUS" | grep -qi "not running\\|failed to start\\|stopped\\|inactive"; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Gateway is not running\${NC}\\n"
elif [ "\$GATEWAY_RUNNING" = "false" ] && ! echo "\$GATEWAY_STATUS" | grep -qi "warning"; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Gateway is not running\${NC}\\n"
fi

if echo "\$GATEWAY_LOG" | grep -qi "EADDRINUSE"; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Port conflict detected\${NC}\\n"
fi

if echo "\$SANITIZED_CONFIG" | jq -e '.plugins.entries["openclaw-mem0"].config.enableGraph == true' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Mem0 enableGraph requires Pro plan (will silently fail)\${NC}\\n"
fi

if [ "\$CONFIG_EXISTS" = true ] && echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults' &>/dev/null && ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.memorySearch.query.hybrid.enabled == true' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  Hybrid search not enabled (recommended)\${NC}\\n"
fi

if [ "\$CONFIG_EXISTS" = true ] && echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults' &>/dev/null && ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.contextPruning' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No context pruning configured\${NC}\\n"
fi

if [ "\$CONFIG_EXISTS" = true ] && echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults' &>/dev/null && ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.compaction.memoryFlush.enabled == true' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  Memory flush not enabled (data loss on compaction)\${NC}\\n"
fi

if [ "\$SOUL_EXISTS" = "false" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No SOUL.md found (agent has no personality)\${NC}\\n"
fi

if [ "\$MEMORY_FILES" -eq 0 ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No memory files found\${NC}\\n"
fi

# Zombie gateway detection
if [ "\$PROCESS_EXISTS" = "true" ] && [ "\$PORT_LISTENING" = "false" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Zombie gateway: process exists (PID \${GATEWAY_PID}) but port not listening\${NC}\\n"
fi

# SIGTERM / crashed service warning
if [ "\$SERVICE_STATE" = "sigterm" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Service received SIGTERM (exit -15) — crash loop or forced kill detected\${NC}\\n"
elif [ "\$SERVICE_STATE" = "crashed" ] || [ "\$SERVICE_STATE" = "failed" ]; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${RED}❌ Service is in \${SERVICE_STATE} state (exit code: \${SERVICE_EXIT_CODE})\${NC}\\n"
fi

if [ \$ISSUES -eq 0 ]; then
  echo -e "\${GREEN}✅ No issues detected! Your OpenClaw looks healthy.\${NC}"
else
  echo -e "\${RED}Found \$ISSUES issue(s):\${NC}"
  echo ""
  echo -e "\$ISSUE_LIST"
fi

echo ""
echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
echo ""

# --- Ask to send for AI analysis ---
if [ \$ISSUES -gt 0 ]; then
  echo -e "\${BOLD}Optional AI analysis can explain problems not covered by deterministic checks.\${NC}"
  echo ""
  echo -e "\${YELLOW}Data that will be sent:\${NC}"
  echo "  • OS type, version, architecture"
  echo "  • Node/npm versions"
  echo "  • OpenClaw version and config (recognized secrets redacted; top-level env omitted)"
  echo "  • Recent logs (up to 30 matching gateway log lines and up to 50 recent stderr lines)"
  echo "  • Plugin status (enabled/disabled only)"
  echo "  • Gateway status"
  echo "  • Source IP is processed transiently by ClawFix for abuse prevention"
  echo "  • Redacted diagnostic data is analyzed by ClawFix and OpenRouter"
  echo ""
  echo -e "\${YELLOW}NOT sent:\${NC}"
  echo "  • Top-level config env block"
  echo "  • File contents (SOUL.md, AGENTS.md, etc.)"
  echo "  • Chat history or messages"
  echo "  • Real hostname (only an 8-character one-way hash is sent)"
  echo ""
  echo -e "\${YELLOW}To inspect the full payload first:\${NC}"
  echo "  npx clawfix --dry-run"
  echo ""
  read -p "Send diagnostic for AI analysis? [y/N] " -n 1 -r
  echo ""
  
  if [[ \$REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "\${BLUE}📡 Sending diagnostic to ClawFix...\${NC}"
    
    RESPONSE=\$(curl -sS -X POST "\$API_URL/api/diagnose" \\
      -H "Content-Type: application/json" \\
      -d "\$DIAGNOSTIC" 2>&1)
    
    if echo "\$RESPONSE" | jq -e '.fixId' &>/dev/null; then
      FIX_ID=\$(echo "\$RESPONSE" | jq -r '.fixId')
      ISSUES_FOUND=\$(echo "\$RESPONSE" | jq -r '.issuesFound // 0')
      echo ""
      echo -e "\${GREEN}✅ Diagnosis complete! Found \${ISSUES_FOUND} issue(s).\${NC}"
      echo ""
      
      # Show known issues
      echo "\$RESPONSE" | jq -r '.knownIssues[]? | "  \\(.severity | ascii_upcase) — \\(.title): \\(.description)"' 2>/dev/null
      
      echo ""
      echo -e "\${BOLD}AI Analysis:\${NC}"
      echo "\$RESPONSE" | jq -r '.analysis // "Pattern matching only (no AI key configured)"' 2>/dev/null
      echo ""
      
      # Save fix script
      echo "\$RESPONSE" | jq -r '.fixScript' > "/tmp/clawfix-\$FIX_ID.sh" 2>/dev/null
      
      echo -e "\${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${NC}"
      echo ""
      echo -e "\${BOLD}📋 Fix script saved to: /tmp/clawfix-\$FIX_ID.sh\${NC}"
      echo -e "   Review it:  \${CYAN}cat /tmp/clawfix-\$FIX_ID.sh\${NC}"
      echo -e "   Apply it:   \${CYAN}bash /tmp/clawfix-\$FIX_ID.sh\${NC}"
      echo ""
      echo -e "\${BOLD}🌐 View results in browser:\${NC}"
      echo -e "   \${CYAN}\$API_URL/results/\$FIX_ID\${NC}"
      echo ""
      echo -e "\${BOLD}Fix ID:\${NC} \$FIX_ID"
    else
      echo -e "\${RED}❌ Error from API:\${NC}"
      echo "\$RESPONSE"
    fi
  else
    echo ""
    echo -e "No problem! You can review the diagnostic data:"
    echo -e "  echo '\$DIAGNOSTIC' | jq ."
    echo ""
    echo -e "Or send it manually later:"
    echo -e "  curl -X POST \$API_URL/api/diagnose -H 'Content-Type: application/json' -d @diagnostic.json"
  fi
else
  echo -e "\${GREEN}Your OpenClaw is looking good! No fixes needed.\${NC}"
  echo -e "If you're still having issues, re-run your reviewed local copy with verbose mode:"
  echo -e "  VERBOSE=1 bash clawfix.sh"
fi

echo ""
echo -e "\${CYAN}🦞 ClawFix — made by Arca (arcabot.eth)\${NC}"
echo -e "\${CYAN}   https://clawfix.dev | https://x.com/arcabotai\${NC}"
echo ""
`;

// Compute hash of the script for verification
const SCRIPT_HASH = createHash('sha256').update(DIAGNOSTIC_SCRIPT).digest('hex');
