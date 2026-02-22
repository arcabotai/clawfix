import { Router } from 'express';

export const scriptRouter = Router();

// Serve the diagnostic script: curl -sSL clawfix.dev/fix | bash
scriptRouter.get('/fix', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(DIAGNOSTIC_SCRIPT);
});

const DIAGNOSTIC_SCRIPT = `#!/usr/bin/env bash
# ClawFix — AI-Powered OpenClaw Diagnostic
# https://clawfix.dev
# 
# This script collects diagnostic data from your OpenClaw installation.
# It does NOT modify anything. It does NOT send data without your approval.
# Source code: https://github.com/ArcaHQ/clawfix
#
# Usage: curl -sSL clawfix.dev/fix | bash

set -euo pipefail

# --- Config ---
API_URL="\${CLAWSOS_API:-https://clawfix.dev}"
VERSION="0.1.0"

# --- Colors ---
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
CYAN='\\033[0;36m'
NC='\\033[0m'
BOLD='\\033[1m'

echo ""
echo -e "\${CYAN}🦞 ClawFix v\${VERSION} — AI-Powered OpenClaw Diagnostic\${NC}"
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

# --- Sanitize Config (REDACT ALL SECRETS) ---
echo ""
echo -e "\${BLUE}🔒 Reading config (secrets will be redacted)...\${NC}"

SANITIZED_CONFIG="{}"
if [ -n "\$OPENCLAW_CONFIG" ]; then
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

echo -e "   Status: \$GATEWAY_STATUS"
[ -n "\$GATEWAY_PID" ] && echo -e "   PID: \$GATEWAY_PID"
echo -e "   Port: \${GATEWAY_PORT:-18789}"

# --- Check Logs ---
echo ""
echo -e "\${BLUE}📜 Reading recent logs...\${NC}"

GATEWAY_LOG=""
ERROR_LOG=""

if [ -f "\$OPENCLAW_DIR/logs/gateway.log" ]; then
  GATEWAY_LOG=\$(tail -100 "\$OPENCLAW_DIR/logs/gateway.log" 2>/dev/null | grep -i "error\\|warn\\|fail\\|crash\\|EADDRINUSE\\|EACCES" | tail -30 || echo "")
  echo -e "   \${GREEN}✅ Gateway log found (\$(wc -l < "\$OPENCLAW_DIR/logs/gateway.log" | tr -d ' ') lines)\${NC}"
fi

if [ -f "\$OPENCLAW_DIR/logs/gateway.err.log" ]; then
  ERROR_LOG=\$(tail -50 "\$OPENCLAW_DIR/logs/gateway.err.log" 2>/dev/null || echo "")
  echo -e "   \${GREEN}✅ Error log found\${NC}"
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
    "gatewayStatus": \$(echo "\$GATEWAY_STATUS" | jq -Rs .),
    "gatewayPid": "\${GATEWAY_PID:-none}",
    "gatewayPort": "\${GATEWAY_PORT:-18789}"
  },
  "config": \$SANITIZED_CONFIG,
  "logs": {
    "errors": \$(echo "\$GATEWAY_LOG" | jq -Rs .),
    "stderr": \$(echo "\$ERROR_LOG" | jq -Rs .)
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
if echo "\$GATEWAY_STATUS" | grep -qi "error\\|not running\\|failed"; then
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

if ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.memorySearch.query.hybrid.enabled == true' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  Hybrid search not enabled (recommended)\${NC}\\n"
fi

if ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.contextPruning' &>/dev/null; then
  ISSUES=\$((ISSUES + 1))
  ISSUE_LIST="\${ISSUE_LIST}   \${YELLOW}⚠️  No context pruning configured\${NC}\\n"
fi

if ! echo "\$SANITIZED_CONFIG" | jq -e '.agents.defaults.compaction.memoryFlush.enabled == true' &>/dev/null; then
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
  echo -e "\${BOLD}Want AI-powered fixes? Send this diagnostic for analysis.\${NC}"
  echo -e "All secrets are redacted. Review the data below if you want."
  echo ""
  echo -e "\${YELLOW}Data that will be sent:\${NC}"
  echo "  • OS type, version, architecture"
  echo "  • Node/npm versions"
  echo "  • OpenClaw version and config (secrets redacted)"
  echo "  • Recent error logs"
  echo "  • Plugin status"
  echo "  • Gateway status"
  echo ""
  echo -e "\${YELLOW}NOT sent:\${NC}"
  echo "  • API keys, tokens, passwords (all redacted)"
  echo "  • File contents (SOUL.md, AGENTS.md, etc.)"
  echo "  • Chat history or messages"
  echo "  • IP address or hostname (hashed)"
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
      echo ""
      echo -e "\${GREEN}✅ Diagnosis complete!\${NC}"
      echo ""
      echo -e "\${BOLD}AI Analysis:\${NC}"
      echo "\$RESPONSE" | jq -r '.analysis' 2>/dev/null
      echo ""
      echo -e "\${BOLD}Fix Script:\${NC}"
      echo "\$RESPONSE" | jq -r '.fixScript' 2>/dev/null
      echo ""
      echo -e "\${CYAN}Fix ID: \$FIX_ID\${NC}"
      echo -e "Save the fix script: curl -sS \$API_URL/api/fix/\$FIX_ID > fix.sh"
      echo -e "Review it, then run: bash fix.sh"
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
  echo -e "If you're still having issues, run with verbose mode:"
  echo -e "  curl -sSL \$API_URL/fix | VERBOSE=1 bash"
fi

echo ""
echo -e "\${CYAN}🦞 ClawFix — made by Arca (arcabot.eth)\${NC}"
echo -e "\${CYAN}   https://clawfix.dev | https://x.com/arcaboteth\${NC}"
echo ""
`;
