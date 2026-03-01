/**
 * Known OpenClaw issues database
 * Each pattern has detection logic and a fix generator.
 * These are issues we've personally encountered and solved.
 */

export const KNOWN_ISSUES = [
  {
    id: 'mem0-graph-free',
    severity: 'critical',
    title: 'Mem0 enableGraph on Free plan',
    description: 'Mem0 plugin has enableGraph: true but this requires the Pro plan ($99/mo). Every autoCapture and autoRecall call silently fails, meaning zero memories are stored.',
    detect: (diag) => {
      try {
        return diag.config?.plugins?.entries?.['openclaw-mem0']?.config?.enableGraph === true;
      } catch { return false; }
    },
    fix: `# Fix: Disable Mem0 graph (requires Pro plan)
jq '.plugins.entries["openclaw-mem0"].config.enableGraph = false' \\
  ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Mem0 graph disabled — autoCapture will now work on Free plan"`,
  },

  {
    id: 'gateway-not-running',
    severity: 'critical',
    title: 'Gateway is not running',
    description: 'The OpenClaw gateway process is not running. This could be due to a config error, port conflict, or crash.',
    detect: (diag) => {
      const status = diag.openclaw?.gatewayStatus || '';
      // Check for explicit "running" indicators first — ignore config warnings
      if (/running.*pid|state active|listening/i.test(status)) return false;
      // Don't double-report if zombie/corrupted-state is detected (more specific)
      if (diag.openclaw?.processExists === true && diag.openclaw?.portListening === false) return false;
      return (/not running|failed to start|stopped|inactive/i.test(status)) ||
             (!diag.openclaw?.gatewayPid && !/warning/i.test(status));
    },
    fix: `# Fix: Restart the gateway
# Try standard restart first
openclaw gateway restart 2>/dev/null && sleep 3 && echo "✅ Gateway restarted" && exit 0

# If that fails, try full launchctl cycle (macOS)
PLIST="\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
if [ -f "\$PLIST" ]; then
  echo "Standard restart failed — trying launchctl full reset..."
  launchctl unload "\$PLIST" 2>/dev/null || true
  sleep 2
  launchctl load "\$PLIST"
  sleep 3
fi

# Or systemd (Linux)
if command -v systemctl &>/dev/null && systemctl list-unit-files openclaw-gateway.service &>/dev/null; then
  sudo systemctl restart openclaw-gateway
fi

# Verify
PORT=\$(jq -r '.gateway.port // 18789' ~/.openclaw/openclaw.json 2>/dev/null || echo "18789")
curl -sf "http://localhost:\$PORT/health" && echo "✅ Gateway is healthy" || echo "❌ Still down — check: tail -30 ~/.openclaw/logs/gateway.err.log"`,
  },

  {
    id: 'port-conflict',
    severity: 'critical',
    title: 'Port conflict (EADDRINUSE)',
    description: 'The gateway port is already in use by another process. This prevents OpenClaw from starting.',
    detect: (diag) => {
      const logs = diag.logs?.errors || '';
      return /EADDRINUSE/i.test(logs);
    },
    fix: `# Fix: Kill the process using the gateway port and restart
PORT=$(jq -r '.gateway.port // 18789' ~/.openclaw/openclaw.json)
PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PID" ]; then
  echo "Killing process $PID on port $PORT"
  kill $PID
  sleep 1
fi
openclaw gateway restart
echo "✅ Port conflict resolved"`,
  },

  {
    id: 'browser-port-binding',
    severity: 'high',
    title: 'Browser control port not binding (18791)',
    description: 'The browser control HTTP server on port 18791 won\'t start. This prevents browser automation from working.',
    detect: (diag) => {
      const logs = diag.logs?.errors || '';
      return /18791.*EADDRINUSE|browser.*control.*fail|browser.*service.*start/i.test(logs);
    },
    fix: `# Fix: Kill stale browser processes and restart
pkill -f "chrome.*--remote-debugging-port" 2>/dev/null
PID=$(lsof -ti :18791 2>/dev/null)
[ -n "$PID" ] && kill $PID
PID=$(lsof -ti :18800 2>/dev/null)
[ -n "$PID" ] && kill $PID
sleep 1
openclaw gateway restart
echo "✅ Browser ports cleared"`,
  },

  {
    id: 'no-hybrid-search',
    severity: 'medium',
    title: 'Hybrid search not enabled',
    description: 'Your memory search is using basic vector search only. Enabling hybrid search (vector + BM25) significantly improves recall, especially for exact matches like wallet addresses, error codes, and names.',
    detect: (diag) => {
      try {
        return !diag.config?.agents?.defaults?.memorySearch?.query?.hybrid?.enabled;
      } catch { return true; }
    },
    fix: `# Fix: Enable hybrid search with recommended weights
jq '.agents.defaults.memorySearch.query.hybrid = {
  "enabled": true,
  "vectorWeight": 0.6,
  "textWeight": 0.4,
  "temporalDecay": {"enabled": true, "halfLifeDays": 14}
}' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Hybrid search enabled (vector 0.6 + BM25 0.4 + temporal decay)"`,
  },

  {
    id: 'no-context-pruning',
    severity: 'medium',
    title: 'No context pruning configured',
    description: 'Without context pruning, old messages pile up and waste your context window. This makes conversations more expensive and can cause compactions to happen more often.',
    detect: (diag) => {
      try {
        return !diag.config?.agents?.defaults?.contextPruning;
      } catch { return true; }
    },
    fix: `# Fix: Enable context pruning (cache-ttl mode, 6 hour TTL)
jq '.agents.defaults.contextPruning = {
  "mode": "cache-ttl",
  "ttl": "6h",
  "keepLastAssistants": 3
}' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Context pruning enabled (6h TTL, keeps last 3 assistant messages)"`,
  },

  {
    id: 'no-memory-flush',
    severity: 'high',
    title: 'Memory flush not enabled',
    description: 'When your context window fills up and compaction happens, important information will be lost. Memory flush automatically saves a summary before compacting.',
    detect: (diag) => {
      try {
        return !diag.config?.agents?.defaults?.compaction?.memoryFlush?.enabled;
      } catch { return true; }
    },
    fix: `# Fix: Enable memory flush with smart prompt
jq '.agents.defaults.compaction = {
  "mode": "safeguard",
  "reserveTokensFloor": 32000,
  "memoryFlush": {
    "enabled": true,
    "softThresholdTokens": 40000,
    "prompt": "Distill this session to memory/YYYY-MM-DD.md (use today'"'"'s date, APPEND only). Focus on: decisions made, state changes, lessons learned, blockers hit, tasks completed/started. Include specific details (IDs, URLs, amounts, error messages). If nothing worth saving, reply NO_REPLY."
  }
}' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Memory flush enabled — context compaction will save summaries"`,
  },

  {
    id: 'no-soul',
    severity: 'low',
    title: 'No SOUL.md found',
    description: 'SOUL.md defines your agent\'s personality and behavior. Without it, your agent is generic and lacks character.',
    detect: (diag) => !diag.workspace?.hasSoul,
    fix: `# Fix: Create a basic SOUL.md
WORKSPACE=$(jq -r '.agents.defaults.workspace // "~/.openclaw/workspace"' ~/.openclaw/openclaw.json)
cat > "$WORKSPACE/SOUL.md" << 'SOUL'
# SOUL.md — Who You Are

You are a helpful AI assistant. Be concise, direct, and genuinely useful.
Have opinions. Be resourceful. Earn trust through competence.

Customize this file to give your agent personality!
SOUL
echo "✅ Created basic SOUL.md at $WORKSPACE/SOUL.md"`,
  },

  {
    id: 'no-memory-files',
    severity: 'low',
    title: 'No memory files found',
    description: 'Your agent has no memory directory or daily note files. This means it can\'t persist knowledge across sessions.',
    detect: (diag) => diag.workspace?.memoryFiles === 0,
    fix: `# Fix: Create memory directory
WORKSPACE=$(jq -r '.agents.defaults.workspace // "~/.openclaw/workspace"' ~/.openclaw/openclaw.json)
mkdir -p "$WORKSPACE/memory"
echo "# Memory" > "$WORKSPACE/MEMORY.md"
echo "✅ Created memory directory at $WORKSPACE/memory/"`,
  },

  {
    id: 'ggml-metal-crash',
    severity: 'high',
    title: 'GGML Metal GPU crash (macOS)',
    description: 'QMD or other GGML-based tools crash with GGML_ASSERT on macOS with Apple Silicon. This is a known Metal GPU bug. Fix: use CPU mode.',
    detect: (diag) => {
      const logs = diag.logs?.errors || '';
      const stderr = diag.logs?.stderr || '';
      return /GGML_ASSERT.*ggml-metal|ggml-metal.*ASSERT/i.test(logs + stderr);
    },
    fix: `# Fix: Disable Metal GPU for GGML (use CPU instead)
# Add to ~/.zshrc or ~/.bashrc
echo 'export GGML_NO_METAL=1' >> ~/.zshrc
# Also add to OpenClaw env
jq '.env.GGML_NO_METAL = "1"' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ GGML Metal disabled — CPU mode active (fixes QMD crashes)"`,
  },

  {
    id: 'orphan-tool-calls',
    severity: 'medium',
    title: 'Orphan tool_calls in session history',
    description: 'Session JSONL files contain tool_call entries without matching tool_result entries. This causes "tool_call_id is not found" errors. Known OpenClaw bug #11187.',
    detect: (diag) => {
      const logs = diag.logs?.errors || '';
      return /tool_call_id.*not found|orphan.*tool/i.test(logs);
    },
    fix: `# Fix: This is a known OpenClaw bug (#11187).
# Workaround: clear the affected session file
# Find session files with orphan tool calls:
find ~/.openclaw/sessions -name "*.jsonl" -exec grep -l "tool_call" {} \\; 2>/dev/null | while read f; do
  echo "Checking: $f"
done
echo "⚠️  If issues persist, try: openclaw gateway restart"
echo "This bug is tracked at: https://github.com/openclaw/openclaw/issues/11187"`,
  },

  {
    id: 'duplicate-plugin',
    severity: 'medium',
    title: 'Duplicate plugin detected',
    description: 'A plugin is registered multiple times in your config. The later entry overrides the earlier one, which may cause unexpected behavior.',
    detect: (diag) => {
      const status = diag.openclaw?.gatewayStatus || '';
      return /duplicate plugin id detected/i.test(status);
    },
    fix: `# Fix: Remove duplicate plugin entries from config
echo "⚠️  Check your openclaw.json for duplicate plugin entries."
echo "Look for plugins listed twice in plugins.entries"
echo "Remove the duplicate and keep the one with your preferred config."
jq '.plugins.entries | keys[]' ~/.openclaw/openclaw.json 2>/dev/null | sort | uniq -d | while read dup; do
  echo "  Duplicate found: $dup"
done
echo "Edit ~/.openclaw/openclaw.json to remove duplicates"`,
  },

  {
    id: 'state-dir-migration',
    severity: 'low',
    title: 'State directory migration skipped',
    description: 'OpenClaw tried to migrate your state directory but the target already exists. This is usually harmless but may indicate a leftover from a previous installation.',
    detect: (diag) => {
      const status = diag.openclaw?.gatewayStatus || '';
      return /State dir migration skipped/i.test(status);
    },
    fix: `# Info: State directory migration was skipped
# This is usually harmless — your ~/.openclaw directory already exists.
# If you have issues, check for leftover files from a previous install:
ls -la ~/.openclaw/ 2>/dev/null
echo "✅ No action needed unless you're experiencing config conflicts"`,
  },

  {
    id: 'large-workspace-files',
    severity: 'medium',
    title: 'Large workspace loaded every session',
    description: 'Your workspace has many markdown files that may be loaded into context every turn, wasting tokens. Consider using progressive context loading with a small index file.',
    detect: (diag) => {
      return (diag.workspace?.mdFiles || 0) > 100 && !diag.workspace?.hasSoul;
    },
    fix: `# Fix: Create a MEMORY.md index to avoid loading everything
WORKSPACE=$(jq -r '.agents.defaults.workspace // "~/.openclaw/workspace"' ~/.openclaw/openclaw.json)
echo "Your workspace has many .md files. Consider:"
echo "1. Create a small MEMORY.md index that points to detailed files"
echo "2. Move old/large files to an archive/ subdirectory"
echo "3. Use .contextignore to exclude files from context loading"
echo ""
echo "Files over 10KB:"
find "$WORKSPACE" -name "*.md" -size +10k -not -path "*/node_modules/*" 2>/dev/null | head -10`,
  },

  {
    id: 'no-compaction-config',
    severity: 'medium',
    title: 'No compaction safeguards',
    description: 'Your context compaction has no reserveTokensFloor configured. When the context window fills up, important context may be lost without warning.',
    detect: (diag) => {
      try {
        const compaction = diag.config?.agents?.defaults?.compaction;
        return !compaction?.reserveTokensFloor && !compaction?.mode;
      } catch { return true; }
    },
    fix: `# Fix: Set compaction safeguards
jq '.agents.defaults.compaction.mode = "safeguard" |
    .agents.defaults.compaction.reserveTokensFloor = 32000' \\
  ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Compaction safeguard enabled (32K token reserve)"`,
  },

  {
    id: 'missing-agents-md',
    severity: 'low',
    title: 'No AGENTS.md found',
    description: 'AGENTS.md provides instructions for your agent on how to use the workspace, handle memory, and behave in different contexts. Without it, your agent lacks operational guidance.',
    detect: (diag) => !diag.workspace?.hasAgents,
    fix: `# Fix: Create a basic AGENTS.md
WORKSPACE=$(jq -r '.agents.defaults.workspace // "~/.openclaw/workspace"' ~/.openclaw/openclaw.json)
cat > "$WORKSPACE/AGENTS.md" << 'EOF'
# AGENTS.md - Workspace Instructions

## Every Session
1. Read SOUL.md — this is who you are
2. Read memory/ files for recent context

## Memory
- Daily notes: memory/YYYY-MM-DD.md
- Long-term: MEMORY.md

## Safety
- Don't run destructive commands without asking
- trash > rm
EOF
echo "✅ Created basic AGENTS.md at $WORKSPACE/AGENTS.md"`,
  },

  {
    id: 'heartbeat-no-model-override',
    severity: 'low',
    title: 'Heartbeat using expensive model',
    description: 'Your heartbeat is not configured with a cheaper model override. Heartbeats run frequently and don\'t need the most powerful model — using a smaller model saves significant token costs.',
    detect: (diag) => {
      try {
        const hb = diag.config?.agents?.defaults?.heartbeat;
        return hb?.every && !hb?.model;
      } catch { return false; }
    },
    fix: `# Fix: Set a cheaper model for heartbeats
jq '.agents.defaults.heartbeat.model = "anthropic/claude-sonnet-4-6"' \\
  ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Heartbeat model set to Sonnet (cheaper than default)"`,
  },

  {
    id: 'session-transcript-not-indexed',
    severity: 'low',
    title: 'Session transcripts not indexed for search',
    description: 'Enabling session transcript indexing improves memory recall by making past conversation content searchable.',
    detect: (diag) => {
      try {
        return !diag.config?.agents?.defaults?.memorySearch?.sessionTranscripts?.enabled;
      } catch { return true; }
    },
    fix: `# Fix: Enable session transcript indexing
jq '.agents.defaults.memorySearch.sessionTranscripts.enabled = true' \\
  ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Session transcript indexing enabled"`,
  },

  {
    id: 'high-token-usage',
    severity: 'medium',
    title: 'High token consumption detected',
    description: 'Your configuration may be causing excessive token usage. Common causes: no context pruning, large workspace files being loaded every turn, or aggressive heartbeat intervals.',
    detect: (diag) => {
      try {
        const heartbeat = diag.config?.agents?.defaults?.heartbeat;
        const pruning = diag.config?.agents?.defaults?.contextPruning;
        // No pruning + frequent heartbeat = token burn
        return !pruning && heartbeat?.every && /^\d+m$/.test(heartbeat.every) && parseInt(heartbeat.every) < 30;
      } catch { return false; }
    },
    fix: `# Fix: Reduce token usage
# 1. Enable context pruning (see fix above)
# 2. Increase heartbeat interval to 30+ minutes
jq '.agents.defaults.heartbeat.every = "30m"' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
# 3. Use a cheaper model for heartbeats
jq '.agents.defaults.heartbeat.model = "anthropic/claude-sonnet-4-6"' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Token usage optimized (30min heartbeat + Sonnet model)"`,
  },

  // ─── New issues from production crash analysis (Feb 2026) ───

  {
    id: 'auto-update-restart-loop',
    severity: 'critical',
    title: 'Auto-update causing gateway restart loop',
    description: 'When update.auto.enabled is true, the gateway detects a new version on boot, triggers a config reload, SIGTERMs itself, then repeats on restart — creating a crash loop. The OS service manager (launchd/systemd) backs off after rapid failures, leaving the gateway dead for hours.',
    detect: (diag) => {
      const autoUpdate = diag.config?.update?.auto?.enabled === true;
      const logs = (diag.logs?.errors || '') + (diag.logs?.gatewayLog || '');
      // Look for rapid SIGTERM cycles
      const sigtermCount = (logs.match(/signal SIGTERM received/gi) || []).length;
      const restartCount = (logs.match(/listening.*PID/gi) || []).length;
      // Auto-update enabled is always worth flagging; crash loop makes it critical
      return autoUpdate && (sigtermCount >= 2 || restartCount >= 3);
    },
    fix: `# Fix: Disable auto-update (causes restart loops with current OpenClaw versions)
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.\$(date +%s)
jq '.update.auto.enabled = false' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Auto-update disabled — use 'openclaw update' manually when ready"
echo "ℹ️  Restart gateway: openclaw gateway restart"`,
  },

  {
    id: 'auto-update-enabled-warning',
    severity: 'medium',
    title: 'Auto-update is enabled (risk of restart loops)',
    description: 'Auto-update is enabled in your config. This can cause the gateway to restart unexpectedly when a new version is detected, especially combined with plugin config reloads. Recommend manual updates instead.',
    detect: (diag) => {
      return diag.config?.update?.auto?.enabled === true;
    },
    fix: `# Fix: Disable auto-update for stability
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.\$(date +%s)
jq '.update.auto.enabled = false' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
echo "✅ Auto-update disabled — run 'openclaw update' manually"`,
  },

  {
    id: 'config-reload-sigterm-cascade',
    severity: 'high',
    title: 'Config reload triggering gateway restarts',
    description: 'Plugin re-registration (especially Mem0) modifies config fields like plugins.installs.*.resolvedAt, triggering config reload evaluations. If the reload causes a gateway restart (SIGTERM), this cascades — especially when combined with auto-update.',
    detect: (diag) => {
      const logs = (diag.logs?.errors || '') + (diag.logs?.gatewayLog || '');
      const reloadAndSigterm = /config change detected.*evaluating reload[\s\S]{0,500}signal SIGTERM received/i.test(logs);
      const multipleReloads = (logs.match(/config change detected.*evaluating reload/gi) || []).length >= 3;
      return reloadAndSigterm || multipleReloads;
    },
    fix: `# Info: Config reload cascade detected
# This happens when plugins modify config fields during registration,
# triggering reload → restart → re-register → reload cycles.
#
# Step 1: Disable auto-update if enabled (primary trigger)
jq '.update.auto.enabled = false' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && \\
  mv /tmp/oc-fix.json ~/.openclaw/openclaw.json
#
# Step 2: Restart gateway cleanly
openclaw gateway restart
echo "✅ Config reload cascade mitigated"
echo "ℹ️  If this recurs, check which plugin is modifying config on startup"`,
  },

  {
    id: 'gateway-extended-downtime',
    severity: 'critical',
    title: 'Gateway was down for extended period',
    description: 'After a crash loop, the OS service manager (launchd on macOS, systemd on Linux) applies exponential backoff on restarts. This can leave the gateway dead for hours without the user knowing. No heartbeats, cron jobs, or monitoring runs during downtime.',
    detect: (diag) => {
      const service = diag.service || {};
      // On macOS: runs > 2 means multiple restarts happened
      if (service.runs > 2 && service.uptimeSeconds < 300) return true;
      // On Linux: NRestarts > 0 with short uptime
      if (service.nRestarts > 0 && service.uptimeSeconds < 300) return true;
      // Also check if gateway PID started very recently but logs show old errors
      return false;
    },
    fix: `# Fix: Gateway was down — restart and verify
openclaw gateway restart
sleep 3
openclaw gateway status
echo ""
echo "⚠️  Check what caused the crash loop:"
echo "   tail -50 ~/.openclaw/logs/gateway.err.log"
echo ""
echo "Common causes:"
echo "  - Auto-update restart loop (disable: jq '.update.auto.enabled = false' ~/.openclaw/openclaw.json)"
echo "  - Port conflict (check: lsof -i :18789)"
echo "  - Plugin crash on startup (check error logs)"`,
  },

  {
    id: 'browser-relay-wrong-port',
    severity: 'high',
    title: 'Browser Relay extension connecting to wrong port',
    description: 'The Chrome Browser Relay extension is configured to connect to the gateway port (18789) instead of the extension relay port (18792). This causes an infinite loop of WebSocket handshake timeouts because the gateway does not have an /extension endpoint. The extension\'s preflight check (HEAD /) passes on the wrong port because both servers return HTTP 200, masking the misconfiguration.',
    detect: (diag) => {
      const logs = diag.logs?.stderr || diag.logs?.errors || '';
      // Key indicator: handshake timeouts on port 18789 from chrome-extension origin
      const wrongPortPattern = /host=127\.0\.0\.1:18789.*chrome-extension|chrome-extension.*:18789/gi;
      const wrongPortHits = (logs.match(wrongPortPattern) || []).length;
      if (wrongPortHits >= 2) return true;
      // Also detect: handshake timeouts + relay not listening (suggests wrong port)
      const handshakeTimeouts = (logs.match(/handshake timeout.*chrome-extension|closed before connect.*chrome-extension/gi) || []).length;
      const relayDown = diag.browser?.relayPortListening === false;
      // If relay IS down and we see chrome-extension handshake failures on gateway, it's wrong port
      if (handshakeTimeouts >= 3 && relayDown) return true;
      return false;
    },
    fix: `# Fix: Browser Relay extension is connecting to the wrong port
echo "The Browser Relay extension is pointed at port 18789 (gateway) instead of 18792 (relay)."
echo ""
echo "The gateway and relay are different services:"
echo "  Port 18789 = Gateway (JSON-RPC, TUI, API) — does NOT handle extension connections"
echo "  Port 18792 = Extension Relay (CDP bridge) — THIS is what the extension needs"
echo ""
echo "To fix:"
echo "  1. Open Chrome → Extensions → OpenClaw Browser Relay → Details → Extension options"
echo "     (or right-click the toolbar icon → Options)"
echo "  2. Change Port from 18789 to 18792"
echo "  3. Verify the gateway token matches your config:"
TOKEN=\$(jq -r '.gateway.auth.token // empty' ~/.openclaw/openclaw.json 2>/dev/null)
if [ -n "\$TOKEN" ]; then
  echo "     Token: \${TOKEN:0:12}... (showing first 12 chars)"
else
  echo "     ⚠️  No gateway token found in config"
fi
echo "  4. Click Save — status should show 'Relay reachable and authenticated'"
echo ""
echo "Verify relay is running:"
if curl -sf http://127.0.0.1:18792/extension/status &>/dev/null; then
  echo "  ✅ Relay is running on port 18792"
  curl -sf http://127.0.0.1:18792/extension/status
else
  echo "  ⚠️  Relay not responding on 18792 — it starts lazily when a browser profile"
  echo "     with driver: 'extension' is first used. Try: openclaw gateway restart"
fi`,
  },

  {
    id: 'browser-relay-not-listening',
    severity: 'high',
    title: 'Extension relay port (18792) not listening',
    description: 'The gateway is running but the extension relay server on port 18792 is not responding. The relay starts lazily inside the gateway process when a browser profile with driver: "extension" is first used. Without it, the Chrome Browser Relay extension cannot connect.',
    detect: (diag) => {
      // Only flag if gateway IS running but relay IS NOT
      const gatewayUp = diag.openclaw?.portListening === true;
      const relayDown = diag.browser?.relayPortListening === false;
      const hasExtension = diag.browser?.extensionInstalled === true;
      // Only relevant if user has the extension installed or is trying to use browser relay
      const wantsRelay = hasExtension || (diag.logs?.stderr || '').includes('chrome-extension');
      return gatewayUp && relayDown && wantsRelay;
    },
    fix: `# Fix: Start the extension relay
echo "The extension relay on port 18792 is not running."
echo "It starts lazily when a browser profile with driver: 'extension' is used."
echo ""
echo "Option 1: Restart the gateway (relay will start on next browser use)"
openclaw gateway restart 2>/dev/null || echo "⚠️  Could not restart — try manually"
sleep 3
echo ""
echo "Option 2: Ensure you have an extension browser profile configured"
echo "Check your openclaw.json for:"
echo '  "browser": { "profiles": { "chrome": { "driver": "extension" } } }'
echo ""
echo "Verify:"
if curl -sf http://127.0.0.1:18792/extension/status &>/dev/null; then
  echo "✅ Relay is now running!"
  curl -sf http://127.0.0.1:18792/extension/status
else
  echo "⚠️  Relay still not responding. Check gateway logs:"
  echo "   tail -20 ~/.openclaw/logs/gateway.err.log"
fi`,
  },

  {
    id: 'browser-relay-outdated',
    severity: 'medium',
    title: 'Browser Relay extension is outdated',
    description: 'The local Chrome extension at ~/.openclaw/browser/chrome-extension/ is missing important upstream improvements including HMAC token derivation (sends raw gateway token instead of derived relay token), connect.challenge handshake protocol, multi-attempt navigation re-attach, and structured options validation. Update to get better security and reliability.',
    detect: (diag) => {
      const ext = diag.browser?.extension || {};
      // Check for missing files that upstream has
      if (ext.missingOptionsValidation === true) return true;
      // Check for missing deriveRelayToken (old auth method)
      if (ext.hasDeriveRelayToken === false) return true;
      return false;
    },
    fix: `# Fix: Update Browser Relay extension from upstream
echo "Your local Browser Relay extension is outdated."
echo ""
echo "The extension is bundled with OpenClaw. Updating OpenClaw should update it:"
echo "  openclaw update"
echo ""
echo "After updating, reload the extension:"
echo "  1. Open chrome://extensions"
echo "  2. Find 'OpenClaw Browser Relay'"
echo "  3. Click the reload (circular arrow) button"
echo ""
echo "If the extension wasn't updated by openclaw update, you can manually sync:"
echo "  - Check upstream: https://github.com/openclaw/openclaw/tree/main/assets/chrome-extension"
echo "  - Local path: ~/.openclaw/browser/chrome-extension/"
echo ""
echo "Key improvements in latest version:"
echo "  ✓ HMAC-derived relay tokens (more secure than raw gateway token)"
echo "  ✓ connect.challenge handshake protocol"
echo "  ✓ Multi-attempt navigation re-attach [300, 700, 1500ms]"
echo "  ✓ Structured options validation with clear error messages"
echo "  ✓ chrome:// URL filtering (won't try to debug chrome:// pages)"`,
  },

  {
    id: 'browser-relay-handshake-spam',
    severity: 'medium',
    title: 'Browser Relay extension spamming failed handshakes',
    description: 'The OpenClaw Browser Relay Chrome extension is repeatedly failing WebSocket handshakes (~every 11 seconds). This bloats gateway.err.log and makes it hard to find real errors. Common causes: wrong port (18789 vs 18792), missing/invalid gateway token, or relay server not running.',
    detect: (diag) => {
      const logs = diag.logs?.stderr || diag.logs?.errors || '';
      const handshakeErrors = (logs.match(/handshake timeout.*chrome-extension|invalid handshake.*chrome-extension|closed before connect.*chrome-extension/gi) || []).length;
      // Don't double-report if wrong-port is already detected
      const wrongPortPattern = /host=127\.0\.0\.1:18789.*chrome-extension/gi;
      const isWrongPort = (logs.match(wrongPortPattern) || []).length >= 2;
      return handshakeErrors >= 5 && !isWrongPort;
    },
    fix: `# Fix: Stop Browser Relay handshake spam
echo "The Browser Relay Chrome extension is failing to connect repeatedly."
echo ""
echo "Common causes (check in order):"
echo ""
echo "1. Wrong port — extension should connect to 18792, not 18789"
echo "   → Open extension options → set Port to 18792"
echo ""
echo "2. Missing/wrong gateway token"
echo "   → Find your token:"
TOKEN=\$(jq -r '.gateway.auth.token // empty' ~/.openclaw/openclaw.json 2>/dev/null)
if [ -n "\$TOKEN" ]; then
  echo "     Token: \${TOKEN:0:12}..."
  echo "   → Paste it in extension options → Gateway Token field"
else
  echo "     ⚠️  No token found in config"
fi
echo ""
echo "3. Relay server not running"
if curl -sf http://127.0.0.1:18792/extension/status &>/dev/null; then
  echo "   ✅ Relay is running"
else
  echo "   ❌ Relay not responding — restart gateway: openclaw gateway restart"
fi
echo ""
echo "4. If you don't use Browser Relay, disable/remove the extension:"
echo "   Chrome → Extensions → OpenClaw Browser Relay → Remove"
echo ""
echo "Truncate the bloated error log:"
tail -1000 ~/.openclaw/logs/gateway.err.log > /tmp/gw-err-trimmed.log && \\
  mv /tmp/gw-err-trimmed.log ~/.openclaw/logs/gateway.err.log
echo "✅ Error log truncated (kept last 1000 lines)"`,
  },

  {
    id: 'matrix-sync-timeout-spam',
    severity: 'low',
    title: 'Matrix sync timeouts spamming error log',
    description: 'Matrix provider sync calls are failing with ESOCKETTIMEDOUT repeatedly. Usually caused by network issues or Matrix homeserver downtime. Not critical but clutters logs.',
    detect: (diag) => {
      const logs = diag.logs?.stderr || diag.logs?.errors || '';
      const timeouts = (logs.match(/ESOCKETTIMEDOUT/gi) || []).length;
      return timeouts >= 3;
    },
    fix: `# Info: Matrix sync timeouts detected
echo "Matrix homeserver sync is timing out repeatedly."
echo ""
echo "This is usually transient. Check:"
echo "  - Network connectivity: curl -s https://matrix.org/_matrix/client/versions"
echo "  - Matrix status: https://status.matrix.org"
echo ""
echo "If you don't use Matrix, disable it:"
echo "  jq '.channels.matrix.enabled = false' ~/.openclaw/openclaw.json > /tmp/oc-fix.json && mv /tmp/oc-fix.json ~/.openclaw/openclaw.json"`,
  },

  {
    id: 'oversized-error-log',
    severity: 'medium',
    title: 'Error log is very large',
    description: 'gateway.err.log has grown very large (50MB+), likely due to repeated errors like browser relay spam or Matrix timeouts. This wastes disk space and makes log analysis slow.',
    detect: (diag) => {
      return (diag.logs?.errLogSizeMB || 0) > 50;
    },
    fix: `# Fix: Truncate oversized error log
echo "Truncating gateway.err.log (keeping last 5000 lines)..."
tail -5000 ~/.openclaw/logs/gateway.err.log > /tmp/gw-trimmed.log && \\
  mv /tmp/gw-trimmed.log ~/.openclaw/logs/gateway.err.log
echo "✅ Error log truncated"
echo ""
echo "To prevent this, identify the source of log spam:"
echo "  tail -100 ~/.openclaw/logs/gateway.err.log | sort | uniq -c | sort -rn | head -5"
echo ""
echo "Common causes: Browser Relay handshake spam, Matrix sync timeouts"`,
  },

  // ─── Production crash scenarios (from real Feb 2026 crash report) ───

  {
    id: 'launchd-corrupted-state',
    severity: 'critical',
    title: 'LaunchAgent in corrupted state (SIGTERM crash loop)',
    description: 'The gateway received SIGTERM (exit code -15) and the LaunchAgent entered a corrupted load state. Simple restart commands fail with I/O errors. Requires a full unload → load cycle via launchctl to recover.',
    detect: (diag) => {
      const serviceState = diag.service?.state || '';
      const exitCode = diag.service?.exitCode || '';
      const manager = diag.service?.manager || '';
      const logs = (diag.logs?.errors || '') + (diag.logs?.stderr || '');
      const sigtermInLogs = (diag.logs?.sigtermCount || 0) >= 1;
      
      // Direct detection: service says SIGTERM, or launchctl shows -15 exit
      if (manager === 'launchd' && (serviceState === 'sigterm' || exitCode === '-15')) return true;
      
      // Also detect: gateway process doesn't exist AND last service state implies SIGTERM
      if (manager === 'launchd' && !diag.openclaw?.processExists && sigtermInLogs) return true;
      
      // Error patterns: "I/O error" on launchctl, service "not found" after crash
      if (/launchctl.*I\/O error|service.*not found.*load/i.test(logs)) return true;
      
      return false;
    },
    fix: `# Fix: LaunchAgent corrupted state — full unload + reload cycle
echo "Performing full LaunchAgent reset..."
echo ""

PLIST="\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"

if [ ! -f "\$PLIST" ]; then
  echo "❌ LaunchAgent plist not found at \$PLIST"
  echo "Try running: openclaw gateway install"
  exit 1
fi

echo "Step 1: Unload LaunchAgent (ignore errors)..."
launchctl unload "\$PLIST" 2>/dev/null || true
sleep 2

echo "Step 2: Kill any zombie gateway processes..."
pkill -f "openclaw.*gateway" 2>/dev/null || true
sleep 1

echo "Step 3: Load LaunchAgent fresh..."
launchctl load "\$PLIST"
sleep 3

echo "Step 4: Verify gateway is up..."
if curl -sf http://localhost:18789/health &>/dev/null; then
  echo "✅ Gateway is up and healthy!"
else
  echo "⚠️  Gateway did not start within 3 seconds. Check logs:"
  echo "   tail -30 ~/.openclaw/logs/gateway.err.log"
  echo "   tail -30 ~/.openclaw/logs/gateway.log"
fi`,
  },

  {
    id: 'gateway-zombie',
    severity: 'critical',
    title: 'Zombie gateway process (PID exists but not listening)',
    description: 'A gateway process exists in the process list but is NOT listening on the expected port. This typically happens after a SIGTERM or crash where the process is still visible but has already shut down internally. A simple restart won\'t work — the zombie must be killed first.',
    detect: (diag) => {
      const processExists = diag.openclaw?.processExists === true;
      const portListening = diag.openclaw?.portListening === false || diag.openclaw?.portListening === 'false';
      // Only flag if we have the processExists field (new diagnostic format) and it's contradictory
      return processExists && portListening;
    },
    fix: `# Fix: Kill zombie gateway process and restart cleanly
echo "Killing zombie gateway process..."
pkill -9 -f "openclaw.*gateway" 2>/dev/null || true
sleep 2

echo "Clearing any stale port locks..."
PORT=\$(jq -r '.gateway.port // 18789' ~/.openclaw/openclaw.json 2>/dev/null || echo "18789")
PID=\$(lsof -ti :\$PORT 2>/dev/null)
[ -n "\$PID" ] && kill -9 "\$PID" 2>/dev/null || true
sleep 1

echo "Restarting gateway..."
if [ -f "\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" ]; then
  # macOS: use launchctl for proper service management
  launchctl unload "\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" 2>/dev/null || true
  sleep 1
  launchctl load "\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
elif command -v systemctl &>/dev/null; then
  systemctl restart openclaw-gateway
else
  openclaw gateway restart
fi

sleep 3

if curl -sf http://localhost:\$PORT/health &>/dev/null; then
  echo "✅ Gateway is now running and healthy!"
else
  echo "⚠️  Gateway not responding. Check:"
  echo "   tail -20 ~/.openclaw/logs/gateway.err.log"
fi`,
  },

  {
    id: 'gateway-not-listening',
    severity: 'critical',
    title: 'Gateway port not listening',
    description: 'The gateway is not listening on its configured port, even though the process may exist. This means no clients can connect — no heartbeats, no cron jobs, no channel messages. This can happen after a crash, SIGTERM, or config error.',
    detect: (diag) => {
      const portListening = diag.openclaw?.portListening;
      // Only use this if we have the portListening field (new format)
      if (portListening === undefined) return false;
      const portNotListening = portListening === false || portListening === 'false';
      const processNotExists = !diag.openclaw?.processExists || diag.openclaw?.processExists === 'false';
      // Zombie case is handled by gateway-zombie; this handles clean non-running
      return portNotListening && processNotExists;
    },
    fix: `# Fix: Gateway not listening — restart via service manager
echo "Gateway is not listening. Attempting restart..."
PORT=\$(jq -r '.gateway.port // 18789' ~/.openclaw/openclaw.json 2>/dev/null || echo "18789")

if [ -f "\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" ]; then
  echo "Using launchctl (macOS)..."
  launchctl unload "\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" 2>/dev/null || true
  sleep 1
  launchctl load "\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
elif command -v systemctl &>/dev/null && systemctl list-unit-files openclaw-gateway.service &>/dev/null; then
  echo "Using systemctl (Linux)..."
  sudo systemctl restart openclaw-gateway
else
  echo "Using openclaw CLI..."
  openclaw gateway restart
fi

sleep 4
if curl -sf "http://localhost:\$PORT/health" &>/dev/null; then
  echo "✅ Gateway is now running!"
else
  echo "❌ Gateway still not responding. Check logs:"
  echo "   tail -30 ~/.openclaw/logs/gateway.err.log"
fi`,
  },

  {
    id: 'gateway-watchdog-missing',
    severity: 'high',
    title: 'No gateway watchdog installed',
    description: 'Your gateway has crashed before but there\'s no automatic watchdog to detect and recover from future crashes. The OS service manager uses exponential backoff on repeated failures, meaning the gateway can stay dead for hours without you knowing. A watchdog checks the health endpoint every 2 minutes and restarts if it\'s down.',
    detect: (diag) => {
      const manager = diag.service?.manager || '';
      const sigtermCount = diag.logs?.sigtermCount || 0;
      const serviceState = diag.service?.state || '';
      
      // Only suggest watchdog if: macOS + gateway has crashed before (SIGTERM or sigterm state)
      const hasCrashed = sigtermCount >= 1 || serviceState === 'sigterm' || serviceState === 'crashed';
      const hasPlist = manager === 'launchd';
      
      // Don't suggest if we can't tell (no service data)
      return hasPlist && hasCrashed;
    },
    fix: `# Fix: Install a gateway watchdog LaunchAgent
echo "Installing gateway health watchdog..."
WATCHDOG_SCRIPT="\$HOME/.openclaw/scripts/gateway-watchdog.sh"
WATCHDOG_PLIST="\$HOME/Library/LaunchAgents/ai.openclaw.gateway-watchdog.plist"
PORT=\$(jq -r '.gateway.port // 18789' ~/.openclaw/openclaw.json 2>/dev/null || echo "18789")

mkdir -p "\$HOME/.openclaw/scripts"

# Create watchdog script
cat > "\$WATCHDOG_SCRIPT" << 'WATCHDOG'
#!/usr/bin/env bash
# OpenClaw Gateway Watchdog
# Checks health endpoint every 2 minutes, restarts if down

PORT=\$(jq -r '.gateway.port // 18789' ~/.openclaw/openclaw.json 2>/dev/null || echo "18789")
PLIST="\$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
LOG="\$HOME/.openclaw/logs/watchdog.log"

if ! curl -sf "http://localhost:\$PORT/health" &>/dev/null; then
  echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Gateway DOWN — attempting recovery" >> "\$LOG"
  launchctl unload "\$PLIST" 2>/dev/null || true
  sleep 2
  pkill -f "openclaw.*gateway" 2>/dev/null || true
  sleep 1
  launchctl load "\$PLIST"
  sleep 5
  if curl -sf "http://localhost:\$PORT/health" &>/dev/null; then
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Gateway RECOVERED" >> "\$LOG"
  else
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Gateway FAILED TO RECOVER — manual intervention needed" >> "\$LOG"
  fi
fi
WATCHDOG
chmod +x "\$WATCHDOG_SCRIPT"
sed -i "s|\\\$HOME|\$HOME|g" "\$WATCHDOG_SCRIPT"

# Create LaunchAgent plist (runs every 2 minutes)
cat > "\$WATCHDOG_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.gateway-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>\$WATCHDOG_SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>\$HOME/.openclaw/logs/watchdog.log</string>
  <key>StandardErrorPath</key>
  <string>\$HOME/.openclaw/logs/watchdog.err.log</string>
</dict>
</plist>
EOF

launchctl unload "\$WATCHDOG_PLIST" 2>/dev/null || true
launchctl load "\$WATCHDOG_PLIST"
echo "✅ Watchdog installed — checks gateway every 2 minutes"
echo "   Log: ~/.openclaw/logs/watchdog.log"
echo "   Disable: launchctl unload \$WATCHDOG_PLIST"`,
  },
];

/**
 * Run all pattern detections against a diagnostic payload
 */
export function detectIssues(diagnostic) {
  return KNOWN_ISSUES
    .filter(issue => {
      try {
        return issue.detect(diagnostic);
      } catch {
        return false;
      }
    })
    .map(issue => ({
      id: issue.id,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      fix: issue.fix,
    }));
}
