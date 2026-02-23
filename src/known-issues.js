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
      return (/not running|failed to start|stopped|inactive/i.test(status)) ||
             (!diag.openclaw?.gatewayPid && !/warning/i.test(status));
    },
    fix: `# Fix: Restart the gateway
openclaw gateway restart
# If that fails, check logs:
# cat ~/.openclaw/logs/gateway.err.log | tail -20`,
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
