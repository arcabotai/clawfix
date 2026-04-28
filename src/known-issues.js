/**
 * Known OpenClaw issues database
 * Each pattern has detection logic and a fix generator.
 * These are issues we've personally encountered and solved.
 */

const BUNDLED_PLUGIN_PATH_RE = /[/\\]openclaw[/\\]dist[/\\]extensions[/\\][^/\\]+[/\\]?$/i;

function logText(diag) {
  return [
    diag.logs?.errors,
    diag.logs?.stderr,
    diag.logs?.gatewayLog,
    diag.openclaw?.gatewayStatus,
  ].filter(Boolean).join('\n');
}

function bundledPluginLoadPaths(config) {
  const paths = config?.plugins?.load?.paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter(p => typeof p === 'string' && BUNDLED_PLUGIN_PATH_RE.test(p));
}

function collectStringValues(obj, out = [], path = []) {
  if (typeof obj === 'string') {
    out.push({ path: path.join('.'), value: obj });
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectStringValues(v, out, path.concat(String(i))));
    return out;
  }
  if (obj && typeof obj === 'object') {
    Object.entries(obj).forEach(([k, v]) => collectStringValues(v, out, path.concat(k)));
  }
  return out;
}

function codexRuntimeAutoPi(config) {
  const refs = collectStringValues(config)
    .filter(({ path, value }) => /(^|\.)(model|primary|fallback)$/i.test(path) && /^openai-codex\//.test(value));
  if (refs.length === 0) return false;

  const codexPlugin = config?.plugins?.entries?.codex || config?.plugins?.entries?.['openclaw-codex'];
  if (codexPlugin?.enabled === false) return false;

  const runtimeId =
    config?.agents?.defaults?.agentRuntime?.id ||
    config?.agentRuntime?.id ||
    'auto';
  return runtimeId !== 'codex';
}

function updateAvailable(update) {
  if (!update || typeof update !== 'object') return false;
  return update.available === true ||
    update.updateAvailable === true ||
    update.hasUpdate === true ||
    update.hasRegistryUpdate === true ||
    update.availability?.available === true ||
    update.registry?.available === true ||
    update.registry?.hasUpdate === true;
}

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

  {
    id: 'macos-app-metadata-upgrade',
    severity: 'high',
    title: 'macOS app blocked after OS update (metadata upgrade)',
    description: 'The OpenClaw macOS app is repeatedly failing to connect with "pairing required" errors after a macOS version update. The gateway detects a platform version mismatch between the pinned metadata (old OS version) and the claimed metadata (new OS version), and requires re-approval. The app keeps retrying in a tight loop, spamming the gateway logs.',
    detect: (diag) => {
      const logs = diag.logs?.raw || diag.logs?.gatewayLog || '';
      const hasMetadataUpgrade = /metadata-upgrade/.test(logs) || /metadata.upgrade/.test(logs);
      const hasPairingRequired = /pairing.required.*openclaw-macos|openclaw-macos.*pairing.required/.test(logs);
      const hasPlatformMismatch = /claimedPlatform.*pinnedPlatform/.test(logs);
      return hasMetadataUpgrade || (hasPairingRequired && hasPlatformMismatch);
    },
    fix: `# Fix: Approve the macOS app metadata upgrade
# The app was paired on an older macOS version and needs re-approval after an OS update.

# List pending device requests
openclaw devices list

# Find the pending request with "repair" flag and approve it
# Replace REQUEST_ID with the actual request ID from the list above
PENDING_ID=\$(openclaw devices list 2>/dev/null | grep -A1 "repair" | head -1 | awk '{print \$2}')
if [ -n "\$PENDING_ID" ]; then
  openclaw devices approve "\$PENDING_ID"
  echo "✅ macOS app re-approved after OS update"
else
  echo "No pending repair request found. Try:"
  echo "  1. Open the OpenClaw macOS app"
  echo "  2. Wait a few seconds for it to attempt connection"
  echo "  3. Run: openclaw devices list"
  echo "  4. Run: openclaw devices approve <request-id>"
fi`,
  },

  // ─── 2026-04-28 additions ──────────────────────────────────────────────
  // Patterns discovered while refreshing a live 2026.4.26 beta install.
  // OpenClaw now bundles stock plugins directly, ACPX warm-up can exceed
  // short health probes, and update status is available from the CLI.

  {
    id: 'bundled-plugin-load-path-aliases',
    severity: 'medium',
    title: 'Redundant bundled plugin paths in plugins.load.paths',
    description: 'plugins.load.paths points back into OpenClaw\'s own bundled dist/extensions directory (for example codex or discord). Current OpenClaw releases bundle those stock plugins directly, so these paths are stale aliases that trigger config warnings and can confuse post-update gateway health checks.',
    detect: (diag) => {
      const paths = diag.configDiagnostics?.bundledPluginLoadPaths || bundledPluginLoadPaths(diag.config);
      if (Array.isArray(paths) && paths.length > 0) return true;
      return /ignored plugins\.load\.paths entry that points at OpenClaw's current bundled plugin directory/i.test(logText(diag));
    },
    fix: `# Fix: remove only bundled OpenClaw plugin aliases from plugins.load.paths
set -u
CFG=~/.openclaw/openclaw.json
[ -f "$CFG" ] || { echo "no config found"; exit 1; }

TS=$(date +%Y%m%d-%H%M%S)
/bin/cp -p "$CFG" "$CFG.pre-bundled-plugin-paths-$TS"
echo "snapshot: $CFG.pre-bundled-plugin-paths-$TS"

CURRENT=$(openclaw config get plugins.load.paths 2>/dev/null || echo '[]')
FILTERED=$(node -e '
let paths = [];
try { paths = JSON.parse(process.argv[1] || "[]"); } catch {}
const bundled = /[\\\\/]openclaw[\\\\/]dist[\\\\/]extensions[\\\\/][^\\\\/]+[\\\\/]?$/i;
const kept = Array.isArray(paths) ? paths.filter(p => typeof p !== "string" || !bundled.test(p)) : [];
process.stdout.write(JSON.stringify(kept));
' "$CURRENT")

if [ "$CURRENT" = "$FILTERED" ]; then
  echo "No bundled plugin aliases found; nothing changed."
else
  openclaw config set plugins.load.paths "$FILTERED" --strict-json --replace
  openclaw config validate
  openclaw gateway restart
  echo "✅ Removed bundled plugin path aliases and restarted gateway"
fi

echo ""
echo "Verify:"
echo "  openclaw plugins doctor"
echo "  openclaw gateway status --deep"`,
  },

  {
    id: 'acpx-startup-warmup-timeout',
    severity: 'low',
    title: 'Gateway health probe timed out during ACPX/Codex warm-up',
    description: 'OpenClaw is still progressing through ACPX/Codex bridge startup, but a short health probe timed out first. Avoid repeated restart loops while logs are moving from hook loading to "embedded acpx runtime backend registered" and finally "[gateway] ready".',
    detect: (diag) => {
      const logs = logText(diag);
      return /gateway timeout after 10000ms|Warm-up: launch agents can take a few seconds|health.*timed out/i.test(logs) &&
        /acpx|loaded \d+ internal hook handlers|embedded acpx runtime backend registered/i.test(logs);
    },
    fix: `# Info: wait for ACPX/Codex warm-up before restarting again
echo "ACPX/Codex startup can take longer than a 10 second health probe."
echo "Wait up to 90 seconds while logs are still progressing:"
echo "  tail -f ~/.openclaw/logs/gateway.log"
echo ""
echo "Healthy progression usually ends with:"
echo "  embedded acpx runtime backend registered"
echo "  Browser control listening on http://127.0.0.1:18791/"
echo "  [gateway] ready"
echo ""
echo "Verify after the warm-up window:"
echo "  openclaw gateway status --deep"
echo "  openclaw health"`,
  },

  {
    id: 'acpx-approve-all-warning',
    severity: 'medium',
    title: 'ACPX permissionMode is approve-all',
    description: 'plugins.entries.acpx.config.permissionMode is "approve-all". This may be intentional for a trusted single-operator workflow, but it is a security audit warning and should be an explicit policy choice rather than a silent default.',
    detect: (diag) => diag.config?.plugins?.entries?.acpx?.config?.permissionMode === 'approve-all' ||
      /plugins\.entries\.acpx\.config\.permissionMode.*approve-all/i.test(logText(diag)),
    fix: `# Info: ACPX approve-all is a policy choice, not an automatic fix
echo "Current setting:"
openclaw config get plugins.entries.acpx.config.permissionMode 2>/dev/null || true
echo ""
echo "If approve-all is not required, pick a narrower ACPX permission mode"
echo "and restart the gateway. Do not change this blindly on a live workflow."
echo ""
echo "Example:"
echo "  openclaw config set plugins.entries.acpx.config.permissionMode approve-reads"
echo "  openclaw gateway restart"
echo ""
echo "Then verify:"
echo "  openclaw security audit --deep"`,
  },

  {
    id: 'codex-runtime-auto-pi-warning',
    severity: 'low',
    title: 'Codex plugin enabled but openai-codex model refs still route through auto/PI runtime',
    description: 'OpenClaw doctor warns when the Codex plugin is enabled while openai-codex/* model references are still routed through agentRuntime.id=auto / PI. Existing installs may intentionally use that route, so ClawFix reports it as an advisory rather than changing model runtime policy.',
    detect: (diag) => codexRuntimeAutoPi(diag.config) ||
      /Codex plugin enabled.*openai-codex|agentRuntime\.id.*auto.*PI/i.test(logText(diag)),
    fix: `# Info: choose Codex runtime routing intentionally
echo "This is advisory. Do not auto-switch runtimes without testing model auth."
echo ""
echo "Current relevant settings:"
openclaw config get agents.defaults.agentRuntime.id 2>/dev/null || true
openclaw config get agents.defaults.model 2>/dev/null || true
openclaw config get agents.defaults.heartbeat.model 2>/dev/null || true
echo ""
echo "If you want native Codex plugin routing, update the runtime/model settings"
echo "in one maintenance window, then run:"
echo "  openclaw config validate"
echo "  openclaw gateway restart"
echo "  openclaw doctor --non-interactive"`,
  },

  {
    id: 'openclaw-update-available',
    severity: 'medium',
    title: 'OpenClaw update is available',
    description: 'openclaw update status reports a newer release than the installed package. Current OpenClaw releases include update hardening, bundled-plugin path fixes, runtime dependency repair progress, openclaw migrate, and nodes remove support.',
    detect: (diag) => updateAvailable(diag.update),
    fix: `# Fix: update OpenClaw and run post-update health checks
set -u
openclaw update status --json
echo ""
read -r -p "Run openclaw update now? [y/N] " ANS
[ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || { echo "skipped"; exit 0; }

openclaw update --yes

echo ""
echo "If post-update health times out, wait for ACPX warm-up before restarting again."
echo "Verify:"
echo "  openclaw gateway status --deep"
echo "  openclaw health"
echo "  openclaw doctor --non-interactive"`,
  },

  // ─── 2026-04-22 additions ──────────────────────────────────────────────
  // Patterns discovered after an `openclaw update` from 2026.4.15 to
  // 2026.4.21 broke in two independent ways. See docs.openclaw.ai/ for
  // upstream context.

  {
    id: 'redacted-placeholder-corruption',
    severity: 'critical',
    title: 'Config has "__OPENCLAW_REDACTED__" persisted as real value',
    description: 'The openclaw CLI\'s display-redaction placeholder ("__OPENCLAW_REDACTED__") is stored as a real value in openclaw.json. Schema validation rejects it because the literal starts with underscore and fails pattern checks (like the ^[A-Z][A-Z0-9_]{0,127}$ for SecretRef ids). `openclaw update` and other commands will refuse to run. Observed after the macOS app auto-updated to a newer version than the installed CLI and rewrote the config through a write path that persisted the placeholder.',
    detect: (diag) => {
      const paths = diag.configDiagnostics?.redactedPlaceholderPaths;
      return Array.isArray(paths) && paths.length > 0;
    },
    fix: `# Fix: restore corrupted fields by direct JSON write
# (openclaw config set refuses to mutate an invalid config — chicken-and-egg)
set -u
CFG=~/.openclaw/openclaw.json
[ -f "$CFG" ] || { echo "no config found"; exit 1; }

TS=$(date +%Y%m%d-%H%M%S)
/bin/cp -p "$CFG" "$CFG.pre-redacted-fix-$TS"
echo "snapshot: $CFG.pre-redacted-fix-$TS"

# Find every path holding the literal placeholder
/usr/bin/env python3 - <<'PY'
import json
d = json.load(open('/Users/'+__import__('os').environ['USER']+'/.openclaw/openclaw.json'))
def walk(o, p=''):
    out=[]
    if isinstance(o, dict):
        for k,v in o.items():
            out += walk(v, f'{p}.{k}' if p else k)
    elif isinstance(o, list):
        for i,v in enumerate(o): out += walk(v, f'{p}[{i}]')
    elif o == '__OPENCLAW_REDACTED__':
        out.append(p)
    return out
paths = walk(d)
if not paths:
    print("No corruption found (maybe already fixed)")
else:
    print(f"Corrupted paths ({len(paths)}):")
    for p in paths: print(f"  {p}")
PY

echo ""
echo "For each path printed above, choose one of:"
echo "  1) If it's a SecretRef .id field (e.g. channels.discord.token.id):"
echo "     edit the JSON to set it back to the real env var name you use,"
echo "     e.g. DISCORD_BOT_TOKEN / MATRIX_ACCESS_TOKEN / <YOUR_PROVIDER>_API_KEY"
echo "  2) If it's an env.vars.* entry: the plist already propagates env vars,"
echo "     so the safest fix is to remove the whole env section entirely:"
echo "       python3 -c 'import json,os,tempfile; p=os.path.expanduser(\"~/.openclaw/openclaw.json\"); d=json.load(open(p)); d.pop(\"env\",None); fd,tmp=tempfile.mkstemp(dir=os.path.dirname(p)); os.write(fd, json.dumps(d,indent=2).encode()); os.close(fd); os.chmod(tmp,0o600); os.replace(tmp,p); print(\"removed env block\")'"
echo ""
echo "After fixing the paths, validate + reload:"
echo "  openclaw config validate && openclaw gateway restart"`,
  },

  {
    id: 'incomplete-npm-install',
    severity: 'high',
    title: 'Incomplete openclaw npm install — deps referenced by built bundle are missing',
    description: 'The installed openclaw package has unmet dependencies that its own built code require()s. Typical symptom: `openclaw channels status --probe` reports "discord failed during register: Cannot find module discord-api-types/v10" (or similar chained missing modules like @buape/carbon, @discordjs/opus, opusscript). This happens when an upstream publish is missing transitive deps from its declared dependencies. One unmet (node-llama-cpp, optional) is expected; more than one is broken.',
    detect: (diag) => {
      const c = diag.install?.unmetCount;
      return typeof c === 'number' && c > 1;
    },
    fix: `# Fix: install the missing deps directly into the openclaw global install
# Uses --no-save to avoid mutating the upstream package.json, and
# --legacy-peer-deps to skirt unrelated peer-dep conflicts.
set -u

OC_BIN=$(which openclaw 2>/dev/null)
OC_DIR=$(dirname "$OC_BIN" | xargs -I{} sh -c 'cd {}/../lib/node_modules/openclaw && pwd')
[ -d "$OC_DIR" ] || OC_DIR=/opt/homebrew/lib/node_modules/openclaw
[ -d "$OC_DIR" ] || { echo "can't find openclaw install"; exit 1; }
echo "openclaw install: $OC_DIR"

# Find what's missing
MISSING=$(/opt/homebrew/bin/npm ls --prefix "$OC_DIR" --depth=0 2>&1 \\
  | grep 'UNMET DEPENDENCY' \\
  | awk '{print $NF}' \\
  | sed 's/@[^@]*$//' \\
  | sort -u \\
  | grep -v '^node-llama-cpp$')

if [ -z "$MISSING" ]; then
  echo "no unmet deps other than the expected optional ones"
  exit 0
fi

echo "Will install into $OC_DIR:"
echo "$MISSING" | sed 's/^/  /'
echo ""
read -r -p "Proceed? [y/N] " ANS
[ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || { echo "skipped"; exit 0; }

cd "$OC_DIR"
/opt/homebrew/bin/npm install --no-save --no-package-lock --legacy-peer-deps $MISSING

# reload the gateway so it picks up the new modules
if launchctl list 2>/dev/null | grep -q ai.openclaw.gateway; then
  launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
  echo "✅ gateway reloaded"
elif command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart openclaw-gateway
fi

echo ""
echo "Verify with: openclaw channels status --probe"`,
  },

  {
    id: 'config-written-by-newer-version',
    severity: 'medium',
    title: 'Config was last written by a newer OpenClaw than the installed CLI',
    description: 'openclaw.json\'s meta.lastTouchedVersion is newer than the currently installed openclaw CLI. This usually means the macOS app (or another installation) auto-updated and touched the shared config file, possibly introducing schema elements the older CLI doesn\'t understand. If you see unexpected "Config invalid" errors, this is often the upstream cause. Often co-occurs with redacted-placeholder-corruption.',
    detect: (diag) => {
      const touched = diag.configDiagnostics?.lastTouchedVersion;
      const installed = diag.openclaw?.version;
      if (!touched || !installed) return false;
      // strip any "OpenClaw " prefix and "(hash)" suffix from installed
      const iv = String(installed).replace(/^OpenClaw\s+/, '').split(/\s+/)[0];
      const semverish = /^\d+\.\d+\.\d+/;
      if (!semverish.test(touched) || !semverish.test(iv)) return false;
      const parts = (v) => v.split('.').map(Number);
      const [a1,a2,a3] = parts(touched);
      const [b1,b2,b3] = parts(iv);
      if (a1 !== b1) return a1 > b1;
      if (a2 !== b2) return a2 > b2;
      return a3 > b3;
    },
    fix: `# Fix: bring the CLI up to the newer version
# The newer version is whatever rewrote the config (usually the macOS app).
# Syncing the CLI removes the mismatch warnings and unlocks openclaw update / doctor.
echo "CLI version installed: $(openclaw --version)"
echo "Config lastTouchedVersion (from openclaw.json): $(jq -r '.meta.lastTouchedVersion // "(unset)"' ~/.openclaw/openclaw.json)"
echo ""
echo "Bring the CLI up to the latest published version:"
echo "  npm install -g openclaw@beta    # or @latest for the stable channel"
echo ""
echo "If you don't want the macOS app to keep pulling ahead:"
echo "  open the OpenClaw app preferences and disable auto-updates,"
echo "  or lock it to the same release channel as your CLI."`,
  },

  // ─── 2026-04-20 additions ──────────────────────────────────────────────
  // Patterns discovered while fixing a live production Mac mini. Each fix
  // script is conservative: backs up before writing, pauses before any
  // destructive step, and prefers `openclaw config set`/`unset` over
  // hand-editing JSON so writes are atomic + schema-validated.

  {
    id: 'provider-prefix-unregistered',
    severity: 'high',
    title: 'Cron falling back: unregistered model provider prefix',
    description: 'An agent config references a provider prefix that isn\'t registered (e.g. "codex/gpt-5.4" instead of "openai-codex/gpt-5.4"). Every cron run logs `payload.model \'X\' not allowed, falling back`, tries the wrong auth, then fallback-hops — manifests as slow replies and 403s in the gateway.',
    detect: (diag) => {
      const logs = (diag.logs?.errors || '') + '\n' + (diag.logs?.stderr || '');
      return /payload\.model ['"][^'"]+['"] not allowed, falling back/i.test(logs);
    },
    fix: `# Fix: locate the bad provider prefix, find the registered equivalent, apply
set -u
ERR=~/.openclaw/logs/gateway.err.log
LOG=~/.openclaw/logs/gateway.log

# Extract the most recent bad prefix from either log
BAD=$(grep -hoE "payload\\.model '[^']+' not allowed" "$ERR" "$LOG" 2>/dev/null \\
      | tail -1 | sed -E "s/.*'([^']+)'.*/\\1/")
if [ -z "\${BAD:-}" ]; then echo "No payload.model error in recent logs — nothing to do."; exit 0; fi

BAD_MODEL="\${BAD##*/}"
echo "Bad prefix in use: $BAD  (model part: $BAD_MODEL)"

# Find registered models with the same model suffix (unambiguous match only)
CANDS=$(openclaw models list --json 2>/dev/null \\
        | grep -oE '"id":[[:space:]]*"[^"]+/'"$BAD_MODEL"'"' \\
        | sed -E 's/.*"([^"]+)"/\\1/' | sort -u)
NUM=$(echo "$CANDS" | grep -c . || true)
if [ "$NUM" != "1" ]; then
  echo "Could not uniquely determine correct prefix. Candidates:"
  echo "$CANDS"
  echo "Re-run 'openclaw models list' and pick the right one, then set manually:"
  echo "  openclaw config set agents.defaults.heartbeat.model '<correct>'"
  exit 1
fi
GOOD="$CANDS"
echo "Auto-detected correct prefix: $GOOD"
echo ""
read -r -p "Apply '$BAD' -> '$GOOD' everywhere it appears? [y/N] " ANS
[ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || { echo "skipped"; exit 0; }

TS=$(date +%Y%m%d-%H%M%S)
/bin/cp -p ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-fix-$TS
echo "Snapshot: ~/.openclaw/openclaw.json.pre-fix-$TS"

for path in agents.defaults.heartbeat.model agents.defaults.subagents.model; do
  if [ "$(openclaw config get "$path" 2>/dev/null)" = "$BAD" ]; then
    openclaw config set "$path" "$GOOD" && echo "  updated $path"
  fi
done

# per-agent list
N=$(jq '.agents.list | length' ~/.openclaw/openclaw.json 2>/dev/null || echo 0)
for i in $(seq 0 $((N-1))); do
  if [ "$(jq -r ".agents.list[$i].model // empty" ~/.openclaw/openclaw.json)" = "$BAD" ]; then
    openclaw config set "agents.list.$i.model" "$GOOD" && echo "  updated agents.list.$i.model"
  fi
done

openclaw config validate && openclaw gateway restart
echo "✅ Provider prefix corrected and gateway restarted"`,
  },

  {
    id: 'discord-allowlist-empty',
    severity: 'high',
    title: 'Discord groupPolicy=allowlist with empty allowFrom — group messages silently dropped',
    description: 'channels.discord.groupPolicy is "allowlist" but channels.discord.allowFrom is absent or empty. Every group message sent to the bot is silently dropped; users report "bot is ignoring me" and there\'s nothing useful in the logs.',
    detect: (diag) => {
      const d = diag.config?.channels?.discord;
      if (!d || d.enabled === false) return false;
      if (d.groupPolicy !== 'allowlist') return false;
      const allow = d.allowFrom;
      return allow == null || (Array.isArray(allow) && allow.length === 0);
    },
    fix: `# Fix: choose one of the two supported remediations
echo "Discord groupPolicy is 'allowlist' but allowFrom is empty."
echo "You have two options:"
echo ""
echo "  A) Keep allowlist, add your user ID(s) (recommended):"
echo "     openclaw config set channels.discord.allowFrom '[\\"<your-user-id>\\"]' --strict-json"
echo "     (find your user ID in Discord: Settings -> Advanced -> Developer Mode,"
echo "      then right-click your name -> Copy User ID)"
echo ""
echo "  B) Open the policy (any user in allowed guilds):"
echo "     openclaw config set channels.discord.groupPolicy open"
echo ""
echo "Then: openclaw gateway restart"
echo ""
echo "This fix is intentionally manual — choose based on your threat model."`,
  },

  {
    id: 'plaintext-secrets-in-config',
    severity: 'high',
    title: 'Plaintext secrets in openclaw.json (migrate to ~/.openclaw/.env + SecretRef)',
    description: 'Fields like channels.discord.token, gateway.auth.token, and models.providers.*.apiKey hold plaintext strings rather than SecretRef objects. These values are auto-copied into the rolling .bak snapshots and baked into the LaunchAgent plist on install — so secrets end up in multiple places on disk. Migrating to ~/.openclaw/.env + SecretRef cuts that to one location.',
    detect: (diag) => {
      // After sanitize, plaintext values become "***REDACTED***" strings;
      // SecretRef objects pass through unchanged as dicts.
      const cfg = diag.config || {};
      const isPlain = (v) => typeof v === 'string' && v.length > 0;
      const candidates = [
        cfg.gateway?.auth?.token,
        cfg.channels?.discord?.token,
        cfg.channels?.matrix?.accessToken,
        cfg.messages?.tts?.providers?.elevenlabs?.apiKey,
      ];
      if (candidates.some(isPlain)) return true;
      const provs = cfg.models?.providers || {};
      for (const p of Object.values(provs)) {
        if (isPlain(p?.apiKey)) return true;
      }
      return false;
    },
    fix: `# Fix: relocate plaintext secrets to ~/.openclaw/.env and re-point config at SecretRefs
# Based on docs.openclaw.ai/gateway/secrets — the env provider pattern.
#
# This script STAGES the work but does not guess which values go where —
# you'll copy values into .env yourself, then re-run to wire the refs.
set -u

ENV=~/.openclaw/.env
touch "$ENV" && /bin/chmod 600 "$ENV"
echo "Ensured $ENV exists with mode 600"
echo ""
echo "Step 1 — add the values you want to migrate to $ENV (one per line)."
echo "Typical mapping:"
echo "  channels.discord.token           ->  DISCORD_BOT_TOKEN"
echo "  gateway.auth.token               ->  GATEWAY_AUTH_TOKEN"
echo "  channels.matrix.accessToken      ->  MATRIX_ACCESS_TOKEN"
echo "  models.providers.<name>.apiKey   ->  <NAME>_PROVIDER_API_KEY"
echo "  messages.tts.providers.elevenlabs.apiKey  ->  ELEVENLABS_API_KEY"
echo ""
echo "Step 2 — for each field, after the value is in .env, run:"
echo "  openclaw config set <dot.path> --ref-provider default --ref-source env --ref-id <VAR>"
echo ""
echo "Step 3 — openclaw config validate && openclaw gateway restart"
echo ""
echo "⚠️  Intentionally interactive: blindly rotating a live token (e.g. Discord bot)"
echo "   would drop an active bot connection — you should do this in a maintenance"
echo "   window with an open 'openclaw logs --follow' to watch reconnects."`,
  },

  {
    id: 'invalid-gh-token-override',
    severity: 'high',
    title: 'Invalid GH_TOKEN/GITHUB_TOKEN env overrides gh CLI and breaks GitHub-using crons',
    description: 'Gateway log shows "The token in GH_TOKEN is invalid" (or the GITHUB_TOKEN variant). gh CLI prefers env over its stored credentials, so every gh call in cron jobs / skills fails with an auth error even though `~/.config/gh/hosts.yml` is fine. Dropping the env override unblocks the stored login.',
    detect: (diag) => {
      const logs = (diag.logs?.errors || '') + '\n' + (diag.logs?.stderr || '');
      return /(The token in GH_TOKEN is invalid|Failed to log in to github\.com using token \(GH_TOKEN\)|GITHUB_TOKEN.*invalid)/i.test(logs);
    },
    fix: `# Fix: drop the invalid env overrides so gh falls back to stored credentials
set -u

# 1) unset in openclaw.json.env if present
openclaw config unset env.GH_TOKEN 2>/dev/null || true
openclaw config unset env.GITHUB_TOKEN 2>/dev/null || true

# 2) strip from ~/.openclaw/.env if present
if [ -f ~/.openclaw/.env ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  /bin/cp -p ~/.openclaw/.env ~/.openclaw/.env.pre-gh-strip-$TS
  /usr/bin/sed -i '' -E '/^(GH_TOKEN|GITHUB_TOKEN)=/d' ~/.openclaw/.env
  echo "Stripped GH_TOKEN/GITHUB_TOKEN from ~/.openclaw/.env (backup: .env.pre-gh-strip-$TS)"
fi

# 3) verify gh CLI can now authenticate via stored creds
if gh auth status 2>&1 | grep -q "Logged in to github.com"; then
  echo "✅ gh CLI is using stored credentials"
else
  echo ""
  echo "⚠️  gh has no valid stored auth either. Re-login:"
  echo "    gh auth login -h github.com --git-protocol https --web -s repo"
fi

openclaw gateway restart
echo "✅ Gateway restarted. New cron runs will use gh's stored token."`,
  },

  {
    id: 'stale-self-paired-node',
    severity: 'medium',
    title: 'Stale paired node generating skills-remote probe timeouts',
    description: 'Gateway log repeatedly shows [skills-remote] remote bin probe timed out. ~/.openclaw/nodes/paired.json holds a node record (often the machine itself) that isn\'t backed by a running node host daemon — so the gateway probes forever and logs a timeout every few minutes.',
    detect: (diag) => {
      const logs = (diag.logs?.errors || '') + '\n' + (diag.logs?.stderr || '');
      return /\[skills-remote\] remote bin probe timed out/i.test(logs);
    },
    fix: `# Fix: remove stale paired nodes (backs up first; restart gateway)
set -u
PAIRED=~/.openclaw/nodes/paired.json
[ -f "$PAIRED" ] || { echo "No paired.json found; nothing to do."; exit 0; }

echo "Current paired nodes:"
openclaw nodes list 2>/dev/null || /usr/bin/env python3 -c "import json;print(list(json.load(open('$PAIRED')).keys()))"
echo ""

TS=$(date +%Y%m%d-%H%M%S)
/bin/cp -p "$PAIRED" "$PAIRED.pre-unpair-$TS"

if openclaw nodes remove --help >/dev/null 2>&1; then
  echo "OpenClaw supports targeted node removal."
  read -r -p "Node id/name/ip to remove (leave blank to skip): " NODE
  if [ -n "$NODE" ]; then
    openclaw nodes remove --node "$NODE"
    echo "✅ Removed stale node: $NODE"
  else
    echo "skipped"
    exit 0
  fi
else
  echo "This OpenClaw build lacks 'openclaw nodes remove'; falling back to clearing paired.json."
  read -r -p "Clear all paired nodes? [y/N] " ANS
  [ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || { echo "skipped"; exit 0; }
  echo '{}' > "$PAIRED"
  /bin/chmod 600 "$PAIRED"
  echo "✅ Paired nodes cleared (backup at $PAIRED.pre-unpair-$TS)"
fi

openclaw gateway restart`,
  },

  {
    id: 'context-overflow',
    severity: 'high',
    title: 'Session stuck at >100% context window — auto-compaction failing',
    description: 'Gateway log shows "Context overflow: estimated context size exceeds safe threshold" and/or "LLM request timed out". Usually a bloated session that won\'t compact. Restart clears in-flight runs; sessions cleanup prunes stale ones.',
    detect: (diag) => {
      const logs = (diag.logs?.errors || '') + '\n' + (diag.logs?.stderr || '');
      return /Context overflow: estimated context size exceeds safe threshold/i.test(logs);
    },
    fix: `# Fix: clear stale/bloated sessions and restart
openclaw sessions cleanup --all-agents --enforce
openclaw tasks maintenance --apply
openclaw gateway restart
echo ""
echo "✅ Stale session entries pruned and gateway restarted."
echo "Verify no session is > 100% context with:"
echo "  openclaw status"
echo ""
echo "If one session persistently re-bloats, check what cron job is driving it:"
echo "  grep -c 'cron:' ~/.openclaw/logs/gateway.log"`,
  },

  // macOS-only: FileVault + plist-managed-env patterns depend on signals
  // the CLI only collects on Darwin. They return `null` on other OSes so
  // detect() returns false there.

  {
    id: 'filevault-blocks-reboot',
    severity: 'low',
    title: 'FileVault is ON — unattended reboots will block at the pre-boot prompt',
    description: 'On macOS, FileVault gates all services behind a disk-unlock prompt that only accepts input at the physical console. Fine if your machine is at a desk you can reach; a real problem for a remote Mac mini accessed only by SSH/Tailscale — the machine will sit off-network after any reboot until someone types the FileVault password.',
    detect: (diag) => diag.system?.os === 'Darwin' && diag.host?.fileVaultOn === true,
    fix: `# Fix (informational): pick one of the three paths below.
# This is a POLICY decision, not an auto-apply — the script echoes the options.

cat <<'EOF'

  Option A — Accept the constraint (default):
    Schedule reboots when someone can reach the physical console. Before a
    planned reboot, pre-authorize one unattended boot:
        sudo fdesetup authrestart

  Option B — Disable FileVault:
    Reboots become unattended. Trade-off: disk at rest is no longer user-
    credential-locked. Reasonable for a machine at a secure known location;
    unsafe for a portable or shared-space device.
        sudo fdesetup disable

  Option C — Out-of-band console (heavier):
    Add a Tailnet-accessible KVM device (e.g. PiKVM) that can type the
    FileVault password on your behalf. Out of scope for this fix.

EOF
echo "No changes made. Pick one of A/B/C and apply yourself."`,
  },

  {
    id: 'stale-plist-env-secrets',
    severity: 'medium',
    title: 'LaunchAgent plist carries stale managed-env secrets',
    description: '~/Library/LaunchAgents/ai.openclaw.gateway.plist has an EnvironmentVariables block with managed keys (PINATA_JWT, FILEBASE_ACCESS_KEY, provider API keys). Those were baked in at install time and aren\'t re-synced when ~/.openclaw/openclaw.json\'s env section changes — so after a secrets migration to ~/.openclaw/.env, secrets still live in the plist too.',
    detect: (diag) => diag.system?.os === 'Darwin' && diag.service?.plistHasManagedEnv === true,
    fix: `# Fix: strip the managed env keys from the plist and reload the LaunchAgent
set -u
PLIST=~/Library/LaunchAgents/ai.openclaw.gateway.plist
[ -f "$PLIST" ] || { echo "plist not found; nothing to do"; exit 0; }

TS=$(date +%Y%m%d-%H%M%S)
/bin/cp -p "$PLIST" "$PLIST.pre-env-strip-$TS"
echo "Snapshot: $PLIST.pre-env-strip-$TS"

MANAGED=$(/usr/bin/plutil -extract EnvironmentVariables.OPENCLAW_SERVICE_MANAGED_ENV_KEYS raw -o - "$PLIST" 2>/dev/null)
if [ -z "\${MANAGED:-}" ]; then
  echo "No managed env keys tracked in plist — nothing to strip."; exit 0
fi

echo "Managed keys listed in plist: $MANAGED"
IFS=',' read -ra KEYS <<< "$MANAGED"
for k in "\${KEYS[@]}"; do
  /usr/bin/plutil -remove "EnvironmentVariables.$k" "$PLIST" 2>/dev/null && echo "  removed $k"
done
/usr/bin/plutil -replace EnvironmentVariables.OPENCLAW_SERVICE_MANAGED_ENV_KEYS -string '' "$PLIST"

# Sanity: is the plist still valid?
/usr/bin/plutil -lint "$PLIST" || { echo "plist broken — restoring backup"; /bin/cp -p "$PLIST.pre-env-strip-$TS" "$PLIST"; exit 1; }

# Reload via launchctl kickstart (no sudo needed; user-level agent)
/bin/launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
echo "✅ plist stripped + gateway reloaded"
echo "Values should already be in ~/.openclaw/.env — verify with:"
echo "  grep -c '^[A-Z_]' ~/.openclaw/.env"`,
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
