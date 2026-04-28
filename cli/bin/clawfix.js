#!/usr/bin/env node

/**
 * ClawFix CLI — AI-powered OpenClaw diagnostic & repair
 * https://clawfix.dev
 *
 * Usage: npx clawfix          (interactive TUI)
 *        npx clawfix --scan   (one-shot scan, legacy mode)
 */

import { readFile, writeFile, copyFile, rename, access, readdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir, platform, arch, release, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// --- Config ---
const API_URL = process.env.CLAWFIX_API || 'https://clawfix.dev';
const VERSION = '0.8.0';

// --- Flags ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('-n');
const SHOW_DATA = args.includes('--show-data') || args.includes('-d');
const AUTO_SEND = process.env.CLAWFIX_AUTO === '1' || args.includes('--yes') || args.includes('-y');
const SHOW_HELP = args.includes('--help') || args.includes('-h');
const SHOW_VERSION = args.includes('--version') || args.includes('-v') || args.includes('-V');
const ONE_SHOT = args.includes('--scan') || args.includes('--no-interactive') || DRY_RUN;

// --- Colors ---
const c = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  blue: s => `\x1b[34m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
};

// --- Helpers ---
async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return ''; }
}

function hashStr(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') return config;

  const redact = (obj) => {
    if (typeof obj === 'string') {
      if (obj.length > 20 && /^(sk-|xai-|eyJ|ghp_|gho_|npm_|m0-|AIza|ntn_)/.test(obj)) return '***REDACTED***';
      if (obj.length > 40 && /^[A-Za-z0-9+/=]+$/.test(obj)) return '***REDACTED***';
      return obj;
    }
    if (Array.isArray(obj)) return obj.map(redact);
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/key|token|secret|password|jwt|apikey|accesstoken/i.test(k)) {
          result[k] = '***REDACTED***';
        } else if (k === 'env') {
          continue;
        } else {
          result[k] = redact(v);
        }
      }
      return result;
    }
    return obj;
  };

  return redact(config);
}

// ============================================================
// Built-in Safe Fix Functions — no jq, no bash, no copy-paste
// ============================================================

const CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

async function backupConfig() {
  const backupPath = `${CONFIG_PATH}.bak.${Date.now()}`;
  await copyFile(CONFIG_PATH, backupPath);
  return backupPath;
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

async function safeWriteConfig(config) {
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await rename(tmpPath, CONFIG_PATH);
}

function tryGatewayRestart() {
  try {
    execSync('openclaw gateway restart 2>&1', { encoding: 'utf8', timeout: 60000 });
    // Give it a moment to come up
    execSync('sleep 3', { timeout: 10000 });
    const status = run('openclaw gateway status 2>&1');
    return /running.*pid|state active/i.test(status);
  } catch {
    return false;
  }
}

/**
 * Built-in fixes keyed by known-issue ID.
 * Each fix modifies the config object in-place and returns { changes: string[] }.
 * All config changes are handled atomically: backup → modify → write → restart → verify.
 */
const BUILTIN_FIXES = {
  'duplicate-plugin': {
    description: 'Set explicit plugin allowlist to prevent duplicate loading',
    risk: 'low',
    needsConfig: true,
    needsRestart: true,
    informational: false,
    apply: (config) => {
      if (!config.plugins) config.plugins = {};
      const entries = config.plugins.entries || {};
      const enabled = Object.keys(entries).filter(k => entries[k]?.enabled !== false);
      if (!config.plugins.allow || config.plugins.allow.length === 0) {
        config.plugins.allow = enabled;
        return { changes: [`Set plugins.allow = [${enabled.map(e => `"${e}"`).join(', ')}]`] };
      }
      return { changes: ['plugins.allow already configured — no change needed'] };
    }
  },

  'config-reload-sigterm-cascade': {
    description: 'Disable auto-update to stop config reload cascade',
    risk: 'low',
    needsConfig: true,
    needsRestart: true,
    informational: false,
    apply: (config) => {
      if (!config.update) config.update = {};
      if (!config.update.auto) config.update.auto = {};
      if (config.update.auto.enabled === true) {
        config.update.auto.enabled = false;
        return { changes: ['Disabled auto-update (was causing restart cascade)'] };
      }
      return { changes: ['Auto-update already disabled'] };
    }
  },

  'auto-update-restart-loop': {
    description: 'Disable auto-update causing restart loop',
    risk: 'low',
    needsConfig: true,
    needsRestart: true,
    informational: false,
    apply: (config) => {
      if (!config.update) config.update = {};
      if (!config.update.auto) config.update.auto = {};
      config.update.auto.enabled = false;
      return { changes: ['Disabled auto-update'] };
    }
  },

  'auto-update-enabled-warning': {
    description: 'Disable auto-update for stability',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: (config) => {
      if (!config.update) config.update = {};
      if (!config.update.auto) config.update.auto = {};
      config.update.auto.enabled = false;
      return { changes: ['Disabled auto-update'] };
    }
  },

  'gateway-not-running': {
    description: 'Restart the OpenClaw gateway',
    risk: 'low',
    needsConfig: false,
    needsRestart: true,
    informational: false,
    apply: () => ({ changes: ['Restart gateway'] })
  },

  'port-conflict': {
    description: 'Kill process on gateway port and restart',
    risk: 'medium',
    needsConfig: true,
    needsRestart: true,
    informational: false,
    apply: (config) => {
      const port = config?.gateway?.port || 18789;
      const pid = run(`lsof -ti :${port} 2>/dev/null`);
      if (pid) {
        try { execSync(`kill ${pid.split('\\n')[0]}`, { timeout: 5000 }); } catch {}
        return { changes: [`Killed process ${pid.split('\\n')[0]} on port ${port}`] };
      }
      return { changes: [`No process found on port ${port}`] };
    }
  },

  'mem0-graph-free': {
    description: 'Disable Mem0 graph mode (requires Pro plan)',
    risk: 'low',
    needsConfig: true,
    needsRestart: true,
    informational: false,
    apply: (config) => {
      const mem0 = config?.plugins?.entries?.['openclaw-mem0']?.config;
      if (mem0 && mem0.enableGraph === true) {
        mem0.enableGraph = false;
        return { changes: ['Set Mem0 enableGraph = false (Pro plan required for graph)'] };
      }
      return { changes: ['Mem0 graph already disabled'] };
    }
  },

  'no-hybrid-search': {
    description: 'Enable hybrid search for better memory recall',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: (config) => {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.memorySearch) config.agents.defaults.memorySearch = {};
      if (!config.agents.defaults.memorySearch.query) config.agents.defaults.memorySearch.query = {};
      config.agents.defaults.memorySearch.query.hybrid = {
        enabled: true,
        vectorWeight: 0.6,
        textWeight: 0.4,
        temporalDecay: { enabled: true, halfLifeDays: 14 }
      };
      return { changes: ['Enabled hybrid search (vector 0.6 + BM25 0.4 + temporal decay)'] };
    }
  },

  'no-context-pruning': {
    description: 'Enable context pruning to reduce token waste',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: (config) => {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      config.agents.defaults.contextPruning = {
        mode: 'cache-ttl',
        ttl: '6h',
        keepLastAssistants: 3
      };
      return { changes: ['Enabled context pruning (6h TTL, keeps last 3 assistant messages)'] };
    }
  },

  'no-memory-flush': {
    description: 'Enable memory flush before context compaction',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: (config) => {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.compaction) config.agents.defaults.compaction = {};
      config.agents.defaults.compaction.mode = 'safeguard';
      config.agents.defaults.compaction.reserveTokensFloor = 32000;
      config.agents.defaults.compaction.memoryFlush = {
        enabled: true,
        softThresholdTokens: 40000,
        prompt: "Distill this session to memory/YYYY-MM-DD.md (use today's date, APPEND only). Focus on: decisions made, state changes, lessons learned, blockers hit, tasks completed/started. Include specific details (IDs, URLs, amounts, error messages). If nothing worth saving, reply NO_REPLY."
      };
      return { changes: ['Enabled memory flush with safeguard mode (32K reserve)'] };
    }
  },

  'no-compaction-config': {
    description: 'Set compaction safeguards to prevent context loss',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: (config) => {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.compaction) config.agents.defaults.compaction = {};
      config.agents.defaults.compaction.mode = 'safeguard';
      config.agents.defaults.compaction.reserveTokensFloor = 32000;
      return { changes: ['Set compaction safeguard (32K token reserve)'] };
    }
  },

  'heartbeat-no-model-override': {
    description: 'Use a cheaper model for heartbeat checks',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: (config) => {
      if (!config.agents?.defaults?.heartbeat) return { changes: ['No heartbeat configured'] };
      config.agents.defaults.heartbeat.model = 'anthropic/claude-sonnet-4-6';
      return { changes: ['Set heartbeat model to Sonnet 4.6 (cheaper)'] };
    }
  },

  'state-dir-migration': {
    description: 'Your ~/.openclaw already exists — no action needed',
    risk: 'none',
    needsConfig: false,
    needsRestart: false,
    informational: true,
    apply: () => ({ changes: ['Informational only — ~/.openclaw already exists, harmless warning'] })
  },

  'no-soul': {
    description: 'Create a basic SOUL.md personality file',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: async (config) => {
      const workspace = config?.agents?.defaults?.workspace;
      if (!workspace) return { changes: ['No workspace configured'] };
      const soulPath = join(workspace, 'SOUL.md');
      if (await exists(soulPath)) return { changes: ['SOUL.md already exists'] };
      await writeFile(soulPath, `# SOUL.md — Who You Are\n\nYou are a helpful AI assistant. Be concise, direct, and genuinely useful.\nHave opinions. Be resourceful. Earn trust through competence.\n\nCustomize this file to give your agent personality!\n`, 'utf8');
      return { changes: ['Created SOUL.md in workspace'] };
    }
  },

  'missing-agents-md': {
    description: 'Create a basic AGENTS.md instruction file',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: async (config) => {
      const workspace = config?.agents?.defaults?.workspace;
      if (!workspace) return { changes: ['No workspace configured'] };
      const agentsPath = join(workspace, 'AGENTS.md');
      if (await exists(agentsPath)) return { changes: ['AGENTS.md already exists'] };
      await writeFile(agentsPath, `# AGENTS.md - Workspace Instructions\n\n## Every Session\n1. Read SOUL.md — this is who you are\n2. Read memory/ files for recent context\n\n## Memory\n- Daily notes: memory/YYYY-MM-DD.md\n- Long-term: MEMORY.md\n\n## Safety\n- Don't run destructive commands without asking\n- trash > rm\n`, 'utf8');
      return { changes: ['Created AGENTS.md in workspace'] };
    }
  },

  'no-memory-files': {
    description: 'Create memory directory for session persistence',
    risk: 'low',
    needsConfig: true,
    needsRestart: false,
    informational: false,
    apply: async (config) => {
      const workspace = config?.agents?.defaults?.workspace;
      if (!workspace) return { changes: ['No workspace configured'] };
      const { mkdir } = await import('node:fs/promises');
      const memDir = join(workspace, 'memory');
      await mkdir(memDir, { recursive: true });
      const memoryMd = join(workspace, 'MEMORY.md');
      if (!await exists(memoryMd)) {
        await writeFile(memoryMd, '# Memory\n\nCurated long-term memory. Updated periodically.\n', 'utf8');
      }
      return { changes: ['Created memory/ directory and MEMORY.md'] };
    }
  },
};

/**
 * Apply a single builtin fix with full safety: backup → apply → write → restart → rescan
 */
async function applyBuiltinFix(issue, builtinFix, rl, scanFn) {
  console.log('');
  console.log(c.bold(`  Fix: ${issue.title || issue.text}`));
  console.log(`  ${c.dim(builtinFix.description)}`);
  console.log(`  Risk: ${builtinFix.risk === 'none' ? c.green('none') : builtinFix.risk === 'low' ? c.green(builtinFix.risk) : c.yellow(builtinFix.risk)}`);
  console.log('');

  if (builtinFix.informational) {
    console.log(c.dim(`  ℹ️  ${builtinFix.description}`));
    console.log('');
    return { skipped: true };
  }

  // Show the plan
  let step = 1;
  console.log(c.bold('  Plan:'));
  if (builtinFix.needsConfig) console.log(`    ${step++}. ${c.green('📋')} Backup config`);
  console.log(`    ${step++}. ${c.blue('🔧')} ${builtinFix.description}`);
  if (builtinFix.needsRestart) console.log(`    ${step++}. ${c.blue('🔄')} Restart gateway`);
  console.log(`    ${step++}. ${c.blue('🔍')} Re-scan to verify`);
  console.log('');

  const answer = await new Promise(resolve => {
    rl.question(`  ${c.yellow('Apply?')} [Y/n] `, resolve);
  });

  if (answer.trim() && !/^y(es)?$/i.test(answer.trim())) {
    console.log(c.dim('  Cancelled.'));
    console.log('');
    return { cancelled: true };
  }

  let backupPath = null;

  try {
    let config = null;

    if (builtinFix.needsConfig) {
      // Backup
      backupPath = await backupConfig();
      console.log(`  ${c.green('✅')} Backed up → ${c.dim(backupPath.split('/').pop())}`);

      // Read config
      config = await readConfig();
    }

    // Apply fix
    const result = await builtinFix.apply(config || {});

    if (builtinFix.needsConfig && config) {
      // Write config
      await safeWriteConfig(config);
    }

    for (const change of result.changes) {
      console.log(`  ${c.green('✅')} ${change}`);
    }

    // Restart if needed
    if (builtinFix.needsRestart) {
      process.stdout.write(`  ${c.blue('🔄')} Restarting gateway...`);
      const ok = tryGatewayRestart();
      console.log(ok ? ` ${c.green('✅')}` : ` ${c.yellow('⚠️  may need manual restart')}`);
    }

    // Re-scan to verify
    if (scanFn) {
      process.stdout.write(`  ${c.blue('🔍')} Re-scanning...`);
      const scanResult = await scanFn();
      if (scanResult) {
        const allAfter = mergeIssues(scanResult.issues, scanResult.serverIssues);
        const stillPresent = allAfter.some(i =>
          (i.id && i.id === issue.id) ||
          ((i.title || i.text || '').toLowerCase().includes((issue.title || issue.text || '').toLowerCase().slice(0, 20)))
        );

        if (stillPresent) {
          console.log(` ${c.yellow('⚠️  issue may persist until gateway fully restarts')}`);
        } else {
          console.log(` ${c.green('✅ Issue resolved!')}`);
        }
      } else {
        console.log(` ${c.dim('skipped')}`);
      }
    }

    console.log('');
    return { applied: true };

  } catch (err) {
    console.log(`  ${c.red('❌')} Error: ${err.message}`);
    if (backupPath) {
      console.log(`  ${c.dim(`Rollback available: cp ${backupPath} ${CONFIG_PATH}`)}`);
    }
    console.log('');
    return { error: err.message };
  }
}

/**
 * Apply all fixable issues at once with single backup and single restart
 */
async function applyAllFixes(issues, serverIssues, rl, scanFn) {
  const allIssues = mergeIssues(issues, serverIssues);
  const fixable = allIssues.filter(i => BUILTIN_FIXES[i.id] && !BUILTIN_FIXES[i.id].informational);

  if (fixable.length === 0) {
    console.log(c.dim('  No auto-fixable issues found.'));
    return null;
  }

  console.log('');
  console.log(c.bold(`  Fix plan (${fixable.length} issues):`));
  for (const issue of fixable) {
    const fix = BUILTIN_FIXES[issue.id];
    const risk = fix.risk === 'low' ? c.green('low') : c.yellow(fix.risk);
    console.log(`    ${c.blue('🔧')} [${risk}] ${issue.title || issue.text}`);
    console.log(`       ${c.dim(fix.description)}`);
  }

  const skipped = allIssues.filter(i => BUILTIN_FIXES[i.id]?.informational);
  if (skipped.length) {
    console.log('');
    for (const issue of skipped) {
      console.log(`    ${c.dim(`ℹ️  [SKIP] ${issue.title || issue.text} — informational`)}`);
    }
  }

  const noFix = allIssues.filter(i => !BUILTIN_FIXES[i.id] && !i.fix);
  if (noFix.length) {
    console.log('');
    for (const issue of noFix) {
      console.log(`    ${c.dim(`❓ [MANUAL] ${issue.title || issue.text} — ask AI for help`)}`);
    }
  }

  console.log('');
  const answer = await new Promise(resolve => {
    rl.question(`  ${c.yellow(`Apply ${fixable.length} fix(es)?`)} [Y/n] `, resolve);
  });

  if (answer.trim() && !/^y(es)?$/i.test(answer.trim())) {
    console.log(c.dim('  Cancelled.'));
    console.log('');
    return null;
  }

  // Single backup
  const backupPath = await backupConfig();
  console.log(`  ${c.green('✅')} Config backed up → ${c.dim(backupPath.split('/').pop())}`);

  // Read config once
  let config = await readConfig();
  let needsRestart = false;
  let applied = 0;

  for (const issue of fixable) {
    const fix = BUILTIN_FIXES[issue.id];
    try {
      const result = await fix.apply(config);
      for (const change of result.changes) {
        console.log(`  ${c.green('✅')} ${change}`);
      }
      if (fix.needsRestart) needsRestart = true;
      applied++;
    } catch (err) {
      console.log(`  ${c.red('❌')} ${issue.title || issue.text}: ${err.message}`);
    }
  }

  // Write config once
  await safeWriteConfig(config);
  console.log(`  ${c.green('✅')} Config saved`);

  // Restart once
  if (needsRestart) {
    process.stdout.write(`  ${c.blue('🔄')} Restarting gateway...`);
    const ok = tryGatewayRestart();
    console.log(ok ? ` ${c.green('✅')}` : ` ${c.yellow('⚠️  may need manual restart')}`);
  }

  // Re-scan
  if (scanFn) {
    process.stdout.write(`  ${c.blue('🔍')} Re-scanning...`);
    await scanFn();
    console.log(` ${c.green('done')}`);
  }

  console.log('');
  console.log(c.green(`  ✅ ${applied}/${fixable.length} fix(es) applied.`));
  if (backupPath) console.log(c.dim(`  Rollback: cp ${backupPath} ${CONFIG_PATH}`));
  console.log('');
  return { applied, total: fixable.length };
}

// ============================================================
// collectDiagnostics() — reusable scan, returns { diagnostic, issues, summary }
// ============================================================
async function collectDiagnostics({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  // --- Detect OpenClaw ---
  const home = homedir();
  const openclawDir = await exists(join(home, '.openclaw')) ? join(home, '.openclaw') :
                       await exists(join(home, '.config', 'openclaw')) ? join(home, '.config', 'openclaw') : null;

  const openclawBin = run('which openclaw') ||
                       (await exists('/opt/homebrew/bin/openclaw') ? '/opt/homebrew/bin/openclaw' : '') ||
                       (await exists('/usr/local/bin/openclaw') ? '/usr/local/bin/openclaw' : '');

  const configPath = openclawDir ? join(openclawDir, 'openclaw.json') : null;

  if (!openclawBin && !openclawDir) {
    return { error: 'OpenClaw not found on this system.' };
  }

  log(c.green('✅ OpenClaw found'));
  if (openclawBin) log(`   Binary: ${openclawBin}`);
  if (openclawDir) log(`   Config: ${openclawDir}`);

  // --- System Info ---
  log('');
  log(c.blue('📋 Collecting system information...'));

  const osName = platform();
  const osVersion = release();
  const osArch = arch();
  const nodeVersion = process.version;
  const npmVersion = run('npm --version');
  const hostHash = hashStr(hostname());

  let ocVersion = '';
  if (openclawBin) {
    ocVersion = run(`"${openclawBin}" --version`);
  }

  log(`   OS: ${osName} ${osVersion} (${osArch})`);
  log(`   Node: ${nodeVersion}`);
  log(`   OpenClaw: ${ocVersion || 'not found'}`);

  // --- Read Config ---
  log('');
  log(c.blue('🔒 Reading config (secrets will be redacted)...'));

  let config = null;
  let sanitizedConfig = {};

  if (configPath && await exists(configPath)) {
    config = await readJson(configPath);
    sanitizedConfig = sanitizeConfig(config) || {};
    log(c.green('   ✅ Config read and sanitized'));
  } else {
    log(c.yellow('   ⚠️  No config file found'));
  }

  // --- Gateway Status ---
  log('');
  log(c.blue('🔌 Checking gateway status...'));

  let gatewayStatus = 'unknown';
  if (openclawBin) {
    gatewayStatus = run(`"${openclawBin}" gateway status 2>&1`) || 'could not check';
  }

  const gatewayPort = config?.gateway?.port || 18789;
  const gatewayPid = run('pgrep -f "openclaw.*gateway"') || '';

  const statusLine = gatewayStatus.split('\n').find(l => /runtime:|listening|running|stopped|not running/i.test(l))
    || gatewayStatus.split('\n')[0];
  log(`   Status: ${statusLine.trim()}`);
  if (gatewayPid) log(`   PID: ${gatewayPid}`);
  log(`   Port: ${gatewayPort}`);

  // --- Logs ---
  log('');
  log(c.blue('📜 Reading recent logs...'));

  let errorLogs = '';
  let stderrLogs = '';
  let gatewayLogTail = '';
  let errLogSizeMB = 0;
  let logSizeMB = 0;

  const logPath = openclawDir ? join(openclawDir, 'logs', 'gateway.log') : null;
  const errLogPath = openclawDir ? join(openclawDir, 'logs', 'gateway.err.log') : null;

  if (logPath && await exists(logPath)) {
    try {
      const logStat = await stat(logPath);
      logSizeMB = Math.round(logStat.size / 1024 / 1024);
      const tailContent = run(`tail -500 "${logPath}" 2>/dev/null`);
      const lines = tailContent.split('\n');
      errorLogs = lines
        .filter(l => /error|warn|fail|crash|EADDRINUSE|EACCES/i.test(l))
        .slice(-30)
        .join('\n');
      gatewayLogTail = lines
        .filter(l => /signal SIGTERM|listening.*PID|config change detected.*reload|update available/i.test(l))
        .slice(-20)
        .join('\n');
      log(c.green(`   ✅ Gateway log found (${logSizeMB}MB, read last 500 lines)`));
    } catch {}
  }

  if (errLogPath && await exists(errLogPath)) {
    try {
      const errStat = await stat(errLogPath);
      errLogSizeMB = Math.round(errStat.size / 1024 / 1024);
      stderrLogs = run(`tail -200 "${errLogPath}" 2>/dev/null`);
      const icon = errLogSizeMB > 50 ? c.yellow('⚠️') : c.green('✅');
      log(`   ${icon} Error log found (${errLogSizeMB}MB${errLogSizeMB > 50 ? ' — OVERSIZED!' : ''})`);
    } catch {}
  }

  // --- Service Health ---
  log('');
  log(c.blue('🔧 Checking service health...'));

  let serviceHealth = {};
  const isMac = osName === 'darwin';
  const isLinux = osName === 'linux';

  if (isMac) {
    const uid = run('id -u');
    const launchdInfo = run(`launchctl print gui/${uid}/ai.openclaw.gateway 2>/dev/null`);
    if (launchdInfo) {
      const runsMatch = launchdInfo.match(/runs = (\d+)/);
      const pidMatch = launchdInfo.match(/pid = (\d+)/);
      const stateMatch = launchdInfo.match(/state = (running|waiting|not running)/);
      const exitCodeMatch = launchdInfo.match(/last exit code = (\d+)/);
      serviceHealth = {
        manager: 'launchd',
        runs: runsMatch ? parseInt(runsMatch[1]) : 0,
        pid: pidMatch ? parseInt(pidMatch[1]) : 0,
        state: stateMatch ? stateMatch[1] : 'unknown',
        lastExitCode: exitCodeMatch ? parseInt(exitCodeMatch[1]) : null,
      };
      if (serviceHealth.pid) {
        const elapsed = run(`ps -p ${serviceHealth.pid} -o etime= 2>/dev/null`).trim();
        serviceHealth.uptimeStr = elapsed;
        const parts = elapsed.replace(/-/g, ':').split(':').reverse().map(Number);
        serviceHealth.uptimeSeconds = (parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600 + (parts[3] || 0) * 86400;
      }
      const runsIcon = serviceHealth.runs > 2 ? c.yellow('⚠️') : c.green('✅');
      log(`   ${runsIcon} LaunchAgent: ${serviceHealth.state} (${serviceHealth.runs} run(s), PID ${serviceHealth.pid || 'none'})`);
      if (serviceHealth.uptimeStr) log(`   Uptime: ${serviceHealth.uptimeStr}`);
      if (serviceHealth.runs > 2) log(c.yellow(`   ⚠️  Multiple restarts detected — possible crash loop`));
    } else {
      log(c.dim('   LaunchAgent not found'));
    }
  } else if (isLinux) {
    const systemdInfo = run('systemctl show openclaw-gateway --property=NRestarts,ActiveState,SubState,ExecMainPID,ExecMainStartTimestamp 2>/dev/null');
    if (systemdInfo) {
      const props = {};
      systemdInfo.split('\n').forEach(l => {
        const [k, v] = l.split('=', 2);
        if (k && v) props[k.trim()] = v.trim();
      });
      serviceHealth = {
        manager: 'systemd',
        nRestarts: parseInt(props.NRestarts) || 0,
        state: props.ActiveState || 'unknown',
        subState: props.SubState || 'unknown',
        pid: parseInt(props.ExecMainPID) || 0,
      };
      log(`   systemd: ${serviceHealth.state}/${serviceHealth.subState} (${serviceHealth.nRestarts} restart(s))`);
    } else {
      log(c.dim('   systemd service not found'));
    }
  } else {
    log(c.dim('   Service manager detection not available on this OS'));
  }

  // --- Plugins ---
  log('');
  log(c.blue('🔌 Checking plugins...'));

  const plugins = config?.plugins?.entries || {};
  for (const [name, cfg] of Object.entries(plugins)) {
    const icon = cfg.enabled === false ? '❌' : '✅';
    log(`   ${icon} ${name}`);
  }

  // --- Workspace ---
  log('');
  log(c.blue('📁 Checking workspace...'));

  const workspaceDir = config?.agents?.defaults?.workspace || '';
  let mdFiles = 0;
  let memoryFiles = 0;
  let hasSoul = false;
  let hasAgents = false;

  if (workspaceDir && await exists(workspaceDir)) {
    hasSoul = await exists(join(workspaceDir, 'SOUL.md'));
    hasAgents = await exists(join(workspaceDir, 'AGENTS.md'));

    try {
      const files = run(`find "${workspaceDir}" -name "*.md" 2>/dev/null | wc -l`);
      mdFiles = parseInt(files) || 0;
    } catch {}

    const memDir = join(workspaceDir, 'memory');
    if (await exists(memDir)) {
      try {
        const mFiles = await readdir(memDir);
        memoryFiles = mFiles.filter(f => f.endsWith('.md')).length;
      } catch {}
    }

    log(`   Path: ${workspaceDir}`);
    log(`   Files: ${mdFiles} .md files`);
    log(`   Memory: ${memoryFiles} daily notes`);
    log(`   SOUL.md: ${hasSoul}`);
    log(`   AGENTS.md: ${hasAgents}`);
  }

  // --- Check Ports ---
  log('');
  log(c.blue('🔗 Checking port availability...'));

  const portResults = {};
  const checkPort = (port, name) => {
    const inUse = run(`lsof -i :${port} 2>/dev/null | grep LISTEN`) ||
                  run(`ss -tlnp 2>/dev/null | grep :${port}`);
    if (inUse) {
      log(c.yellow(`   ⚠️  Port ${port} (${name}) — IN USE`));
      portResults[port] = true;
      return true;
    } else {
      log(c.green(`   ✅ Port ${port} (${name}) — available`));
      portResults[port] = false;
      return false;
    }
  };

  checkPort(gatewayPort, 'gateway');
  checkPort(18800, 'browser CDP');
  checkPort(18791, 'browser control');

  // --- Local Issue Detection ---
  const issues = [];
  const activeModelRefs = [];
  const addActiveModelRef = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      activeModelRefs.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(addActiveModelRef);
    }
  };
  const defaults = config?.agents?.defaults || {};
  addActiveModelRef(defaults.model);
  addActiveModelRef(defaults.model?.primary);
  addActiveModelRef(defaults.model?.fallbacks);
  addActiveModelRef(defaults.compaction?.model);
  addActiveModelRef(defaults.heartbeat?.model);
  addActiveModelRef(defaults.subagents?.model);
  if (Array.isArray(config?.agents?.list)) {
    for (const agent of config.agents.list) {
      addActiveModelRef(agent?.model);
      addActiveModelRef(agent?.model?.primary);
      addActiveModelRef(agent?.model?.fallbacks);
    }
  }
  const agentRuntimes = [
    defaults.agentRuntime,
    ...(Array.isArray(config?.agents?.list) ? config.agents.list.map(agent => agent?.agentRuntime) : []),
  ].filter(Boolean);
  const hasPiFallback = agentRuntimes.some(runtime => (
    runtime === 'pi' ||
    runtime?.id === 'pi' ||
    runtime?.fallback === 'pi'
  ));
  const hasNativeCodexRuntime = agentRuntimes.some(runtime => (
    runtime === 'codex' ||
    runtime?.id === 'codex'
  ));
  const codexPlugin = config?.plugins?.entries?.codex || null;
  const codexPluginEnabled = !!codexPlugin && codexPlugin.enabled !== false;
  const codexAppServer = codexPlugin?.config?.appServer || {};
  const combinedLogs = [errorLogs, stderrLogs, gatewayLogTail, gatewayStatus].filter(Boolean).join('\n');

  const gatewayRunning = /running.*pid|state active|listening/i.test(gatewayStatus);
  const gatewayFailed = /not running|failed to start|stopped|inactive/i.test(gatewayStatus);
  if (gatewayFailed || (!gatewayRunning && !/warning/i.test(gatewayStatus))) {
    issues.push({ severity: 'critical', text: 'Gateway is not running' });
  }
  if (/EADDRINUSE/i.test(errorLogs)) {
    issues.push({ severity: 'critical', text: 'Port conflict detected' });
  }
  if ((config?.plugins?.load?.paths || []).some(path => (
    typeof path === 'string' && /openclaw\/dist\/extensions\//.test(path)
  )) || /ignored plugins\.load\.paths entry.*bundled plugin directory/i.test(combinedLogs)) {
    issues.push({ severity: 'medium', text: 'Stale bundled plugin load paths configured' });
  }
  if (codexPluginEnabled && (activeModelRefs.some(ref => String(ref).startsWith('openai-codex/')) || hasPiFallback)) {
    issues.push({ severity: 'high', text: 'PI-backed openai-codex route active instead of native Codex harness' });
  }
  if (/Codex cannot access session files.*\.codex[\/\\]sessions|Operation not permitted.*\.codex[\/\\]sessions|permission denied.*\.codex[\/\\]sessions/i.test(combinedLogs) ||
      (hasNativeCodexRuntime && codexAppServer.sandbox === 'workspace-write')) {
    issues.push({ severity: 'high', text: 'Codex session-store permission failure' });
  }
  if (codexPluginEnabled &&
      (hasNativeCodexRuntime || activeModelRefs.some(ref => String(ref).startsWith('openai/'))) &&
      codexAppServer.serviceTier !== 'fast') {
    issues.push({ severity: 'low', text: 'Codex app-server fast tier is not enabled' });
  }

  const sigtermCount = (gatewayLogTail.match(/signal SIGTERM/gi) || []).length;
  const restartCount = (gatewayLogTail.match(/listening.*PID/gi) || []).length;
  if (config?.update?.auto?.enabled === true && (sigtermCount >= 2 || restartCount >= 3)) {
    issues.push({ severity: 'critical', text: 'Auto-update causing gateway restart loop' });
  } else if (config?.update?.auto?.enabled === true) {
    issues.push({ severity: 'medium', text: 'Auto-update enabled (risk of restart loops)' });
  }

  const reloadCount = (gatewayLogTail.match(/config change detected.*evaluating reload/gi) || []).length;
  if (reloadCount >= 3) {
    issues.push({ severity: 'high', text: `Config reload cascade detected (${reloadCount} reloads in recent logs)` });
  }

  if (serviceHealth.runs > 2 && (serviceHealth.uptimeSeconds || 0) < 300) {
    issues.push({ severity: 'critical', text: `Gateway crash loop — ${serviceHealth.runs} restarts, only ${serviceHealth.uptimeStr} uptime` });
  } else if ((serviceHealth.nRestarts || 0) > 0) {
    issues.push({ severity: 'high', text: `Gateway has restarted ${serviceHealth.nRestarts} time(s) (systemd)` });
  }

  const handshakeSpam = (stderrLogs.match(/invalid handshake.*chrome-extension|closed before connect.*chrome-extension/gi) || []).length;
  if (handshakeSpam >= 5) {
    issues.push({ severity: 'medium', text: 'Browser Relay extension spamming invalid handshakes' });
  }

  if (errLogSizeMB > 50) {
    issues.push({ severity: 'medium', text: `Error log is ${errLogSizeMB}MB (should be <50MB)` });
  }

  const matrixTimeouts = (stderrLogs.match(/ESOCKETTIMEDOUT/gi) || []).length;
  if (matrixTimeouts >= 3) {
    issues.push({ severity: 'low', text: 'Matrix sync timeouts spamming error log' });
  }

  if (config?.plugins?.entries?.['openclaw-mem0']?.config?.enableGraph === true) {
    issues.push({ severity: 'high', text: 'Mem0 enableGraph requires Pro plan (will silently fail)' });
  }
  if (!config?.agents?.defaults?.memorySearch?.query?.hybrid?.enabled) {
    issues.push({ severity: 'medium', text: 'Hybrid search not enabled (recommended)' });
  }
  if (!config?.agents?.defaults?.contextPruning) {
    issues.push({ severity: 'medium', text: 'No context pruning configured' });
  }
  if (!config?.agents?.defaults?.compaction?.memoryFlush?.enabled) {
    issues.push({ severity: 'medium', text: 'Memory flush not enabled (data loss on compaction)' });
  }
  if (!hasSoul && workspaceDir) {
    issues.push({ severity: 'low', text: 'No SOUL.md found (agent has no personality)' });
  }
  if (memoryFiles === 0 && workspaceDir) {
    issues.push({ severity: 'low', text: 'No memory files found' });
  }

  // --- Build Payload ---
  const diagnostic = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    hostHash,
    system: {
      os: osName,
      osVersion,
      arch: osArch,
      nodeVersion,
      npmVersion,
    },
    openclaw: {
      version: ocVersion || 'unknown',
      binary: openclawBin || 'not found',
      configDir: openclawDir || 'not found',
      gatewayStatus,
      gatewayPid: gatewayPid || 'none',
      gatewayPort,
    },
    config: sanitizedConfig,
    logs: {
      errors: errorLogs,
      stderr: stderrLogs,
      gatewayLog: gatewayLogTail,
      errLogSizeMB,
      logSizeMB,
    },
    service: serviceHealth,
    workspace: {
      path: workspaceDir || 'unknown',
      mdFiles,
      memoryFiles,
      hasSoul,
      hasAgents,
    },
    browser: {
      status: openclawDir && await exists(join(openclawDir, 'browser')) ? 'configured' : 'not configured',
    },
  };

  // Build summary for TUI display
  const gatewayIcon = gatewayRunning ? c.green('✓') : c.red('✗');
  const gatewayLabel = gatewayRunning
    ? `running (pid ${gatewayPid || '?'}, port ${gatewayPort})`
    : 'not running';
  const configIcon = config ? c.green('✓') : c.yellow('⚠');
  const configLabel = config ? 'loaded' : 'not found';
  const issueIcon = issues.length === 0 ? c.green('✓') : c.yellow('⚠');
  const issueLabel = issues.length === 0 ? 'No issues' : `${issues.length} issue(s) detected`;

  const summary = {
    gateway: { icon: gatewayIcon, label: gatewayLabel },
    config: { icon: configIcon, label: configLabel },
    issues: { icon: issueIcon, label: issueLabel },
    node: nodeVersion,
    os: `${osName === 'darwin' ? 'macOS' : osName} ${osVersion}`,
    ocVersion: ocVersion || 'unknown',
  };

  return { diagnostic, issues, summary };
}

// ============================================================
// One-shot mode (legacy: --scan, --dry-run, --no-interactive)
// ============================================================
async function runOneShotMode() {
  console.log('');
  console.log(c.cyan(`🦞 ClawFix v${VERSION} — AI-Powered OpenClaw Diagnostic`));
  if (DRY_RUN) console.log(c.yellow('   🔍 DRY RUN MODE — nothing will be sent'));
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  const result = await collectDiagnostics();

  if (result.error) {
    console.log(c.red(`❌ ${result.error}`));
    console.log('Make sure OpenClaw is installed: https://openclaw.ai');
    process.exit(1);
  }

  const { diagnostic, issues } = result;

  // --- Display issues ---
  console.log('');
  console.log(c.cyan('━'.repeat(50)));
  console.log(c.bold('📊 Diagnostic Summary'));
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  if (issues.length === 0) {
    console.log(c.green('✅ No issues detected! Your OpenClaw looks healthy.'));
  } else {
    console.log(c.red(`Found ${issues.length} issue(s):`));
    console.log('');
    for (const issue of issues) {
      const icon = issue.severity === 'critical' ? c.red('❌') :
                   issue.severity === 'high' ? c.red('❌') :
                   c.yellow('⚠️');
      console.log(`   ${icon} [${issue.severity.toUpperCase()}] ${issue.text}`);
    }
  }

  console.log('');
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  // --- Show collected data ---
  if (DRY_RUN || SHOW_DATA) {
    console.log('');
    console.log(c.bold('📦 Data that would be sent:'));
    console.log(c.cyan('━'.repeat(50)));
    console.log(JSON.stringify(diagnostic, null, 2));
    console.log(c.cyan('━'.repeat(50)));
    console.log('');
  }

  if (DRY_RUN) {
    console.log(c.yellow('🔍 Dry run complete — nothing was sent.'));
    console.log('');
    console.log('To send this data for AI analysis:');
    console.log(c.cyan('  npx clawfix'));
    console.log('');
    console.log(c.cyan('🦞 ClawFix — made by Arca (arcabot.eth)'));
    console.log(c.cyan('   https://clawfix.dev | https://x.com/arcabotai'));
    console.log('');
    return;
  }

  if (issues.length === 0) {
    console.log(c.green('Your OpenClaw is looking good! No fixes needed.'));
    console.log(`If you're still having issues, run with --show-data to see what would be collected.`);
    console.log('');
    console.log(c.cyan(`🦞 ClawFix — made by Arca (arcabot.eth)`));
    console.log(c.cyan(`   https://clawfix.dev | https://x.com/arcabotai`));
    console.log('');
    return;
  }

  console.log(c.bold('Want AI-powered fixes? Send this diagnostic for analysis.'));
  console.log('');
  console.log(c.dim('Data sent:     OS, versions, OpenClaw config (secrets redacted), error logs'));
  console.log(c.dim('NOT sent:      API keys, file contents, chat history, real hostname'));
  console.log(c.dim('Inspect first: npx clawfix --dry-run'));
  console.log('');

  let shouldSend = AUTO_SEND;
  if (!shouldSend) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question('Send diagnostic for AI analysis? [y/N] ', resolve);
    });
    rl.close();
    shouldSend = /^y(es)?$/i.test(answer.trim());
  }

  if (!shouldSend) {
    console.log('');
    console.log('No problem! Review data first with:');
    console.log(c.cyan('  npx clawfix --dry-run'));
    console.log('');
    return;
  }

  console.log('');
  console.log(c.blue('📡 Sending diagnostic to ClawFix...'));

  try {
    const response = await fetch(`${API_URL}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diagnostic),
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const fixId = result.fixId;

    console.log('');
    console.log(c.green(`✅ Diagnosis complete! Found ${result.issuesFound} issue(s).`));
    console.log('');

    if (result.knownIssues) {
      for (const issue of result.knownIssues) {
        console.log(`  ${issue.severity.toUpperCase()} — ${issue.title}: ${issue.description}`);
      }
    }

    console.log('');
    console.log(c.bold('AI Analysis:'));
    console.log(result.analysis || 'Pattern matching only (no AI configured)');
    console.log('');

    if (result.fixScript) {
      const { writeFile } = await import('node:fs/promises');
      const fixPath = `/tmp/clawfix-${fixId}.sh`;
      await writeFile(fixPath, result.fixScript);

      console.log(c.cyan('━'.repeat(50)));
      console.log('');
      console.log(c.bold(`📋 Fix script saved to: ${fixPath}`));
      console.log(`   Review it:  ${c.cyan(`cat ${fixPath}`)}`);
      console.log(`   Apply it:   ${c.cyan(`bash ${fixPath}`)}`);
      console.log('');
      console.log(c.bold('🌐 View results in browser:'));
      console.log(`   ${c.cyan(`${API_URL}/results/${fixId}`)}`);
      console.log('');
      console.log(`${c.bold('Fix ID:')} ${fixId}`);
    }
  } catch (err) {
    console.log(c.red(`❌ Error: ${err.message}`));
    console.log('');
    console.log('Try the web version instead:');
    console.log(c.cyan('  curl -sSL clawfix.dev/fix | bash'));
  }

  console.log('');
  console.log(c.cyan('🦞 ClawFix — made by Arca (arcabot.eth)'));
  console.log(c.cyan('   https://clawfix.dev | https://x.com/arcabotai'));
  console.log('');
}

// ============================================================
// Interactive TUI mode (default)
// ============================================================
async function runInteractiveMode() {
  const conversationId = randomUUID();
  let diagnosticId = null;
  let issues = [];
  let diagnostic = null;
  let summary = null;
  let serverIssues = null; // issues returned from server after /api/diagnose

  // --- Concurrency guard ---
  let busy = false;
  // --- Paste detection: batch rapid lines into one message ---
  let pasteBuffer = [];
  let pasteTimer = null;
  const PASTE_DELAY_MS = 80; // lines arriving within 80ms = paste

  // --- Clear screen and show header ---
  process.stdout.write('\x1b[2J\x1b[H');

  console.log('');
  console.log(c.cyan(`🦞 ClawFix v${VERSION}`));
  console.log(c.cyan('━'.repeat(48)));
  console.log('');
  console.log(c.dim('Scanning your OpenClaw installation...'));
  console.log('');

  // --- Auto-scan on startup ---
  const scanResult = await collectDiagnostics({ quiet: true });

  if (scanResult.error) {
    console.log(c.red(`❌ ${scanResult.error}`));
    console.log('Make sure OpenClaw is installed: https://openclaw.ai');
    process.exit(1);
  }

  diagnostic = scanResult.diagnostic;
  issues = scanResult.issues;
  summary = scanResult.summary;

  // --- Send diagnostic to server for AI context ---
  try {
    // Include locally-detected issues so server can match them to known fixes
    const payload = { ...diagnostic, _localIssues: issues.map(i => ({ severity: i.severity, text: i.text })) };
    const resp = await fetch(`${API_URL}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data = await resp.json();
      diagnosticId = data.fixId;
      serverIssues = data.knownIssues || [];
    }
  } catch {
    // Server unavailable — continue in local-only mode
  }

  // --- Render TUI ---
  renderStatus(summary, issues, serverIssues);

  // --- Start interactive prompt ---
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan('clawfix')}${c.dim('>')} `,
    terminal: true,
  });

  // --- Process a single input (command or chat) ---
  async function handleInput(input) {
    if (!input) {
      rl.prompt();
      return;
    }

    // --- Built-in commands ---
    if (/^(exit|quit|q)$/i.test(input)) {
      console.log('');
      console.log(c.cyan('🦞 ClawFix — made by Arca (arcabot.eth)'));
      console.log(c.cyan('   https://clawfix.dev'));
      console.log('');
      process.exit(0);
    }

    if (/^(help|\?)$/i.test(input)) {
      renderHelp();
      rl.prompt();
      return;
    }

    if (/^(scan|rescan)$/i.test(input)) {
      console.log('');
      console.log(c.dim('Rescanning...'));
      console.log('');
      const result = await collectDiagnostics({ quiet: true });
      if (!result.error) {
        diagnostic = result.diagnostic;
        issues = result.issues;
        summary = result.summary;

        // Re-send to server
        try {
          const payload = { ...diagnostic, _localIssues: issues.map(i => ({ severity: i.severity, text: i.text })) };
          const resp = await fetch(`${API_URL}/api/diagnose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (resp.ok) {
            const data = await resp.json();
            diagnosticId = data.fixId;
            serverIssues = data.knownIssues || [];
          }
        } catch {}
      }
      renderStatus(summary, issues, serverIssues);
      rl.prompt();
      return;
    }

    if (/^issues?$/i.test(input)) {
      renderIssues(issues, serverIssues);
      rl.prompt();
      return;
    }

    if (/^status$/i.test(input)) {
      renderStatus(summary, issues, serverIssues);
      rl.prompt();
      return;
    }

    // fix-all — apply all auto-fixable issues at once
    if (/^fix[\s-]?all$/i.test(input)) {
      const scanFn = async () => {
        const result = await collectDiagnostics({ quiet: true });
        if (!result.error) {
          diagnostic = result.diagnostic;
          issues = result.issues;
          summary = result.summary;
          // Re-send to server for updated known issues
          try {
            const payload = { ...diagnostic, _localIssues: issues.map(i => ({ severity: i.severity, text: i.text })) };
            const resp = await fetch(`${API_URL}/api/diagnose`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (resp.ok) {
              const data = await resp.json();
              diagnosticId = data.fixId;
              serverIssues = data.knownIssues || [];
            }
          } catch {}
          return { issues, serverIssues };
        }
        return null;
      };

      await applyAllFixes(issues, serverIssues, rl, scanFn);
      rl.prompt();
      return;
    }

    // fix <id> — show details + auto-fix with confirmation
    const fixMatch = input.match(/^fix\s+(\d+)$/i);
    if (fixMatch) {
      const idx = parseInt(fixMatch[1]) - 1;
      const allIssues = mergeIssues(issues, serverIssues);
      if (idx < 0 || idx >= allIssues.length) {
        console.log(c.red(`  No issue #${fixMatch[1]}. Use ${c.cyan('issues')} to see the list.`));
      } else {
        const issue = allIssues[idx];
        const builtinFix = BUILTIN_FIXES[issue.id];

        if (builtinFix) {
          // Safe builtin fix — backup, apply, restart, verify
          const scanFn = async () => {
            const result = await collectDiagnostics({ quiet: true });
            if (!result.error) {
              diagnostic = result.diagnostic;
              issues = result.issues;
              summary = result.summary;
              try {
                const payload = { ...diagnostic, _localIssues: issues.map(i => ({ severity: i.severity, text: i.text })) };
                const resp = await fetch(`${API_URL}/api/diagnose`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                });
                if (resp.ok) {
                  const data = await resp.json();
                  diagnosticId = data.fixId;
                  serverIssues = data.knownIssues || [];
                }
              } catch {}
              return { issues, serverIssues };
            }
            return null;
          };
          await applyBuiltinFix(issue, builtinFix, rl, scanFn);
        } else if (issue.fix) {
          // Legacy bash fix (from server) — show script
          console.log('');
          console.log(c.bold(`  Issue #${idx + 1}: ${issue.title || issue.text}`));
          console.log(`  Severity: ${severityColor(issue.severity)}`);
          if (issue.description) console.log(`  ${issue.description}`);
          console.log('');
          console.log(c.dim('  Suggested fix script (review before running):'));
          console.log(c.dim('  ─────────────────────────────'));
          for (const line of issue.fix.split('\n').slice(0, 15)) {
            console.log(`  ${c.dim(line)}`);
          }
          if (issue.fix.split('\n').length > 15) {
            console.log(c.dim(`  ... (${issue.fix.split('\n').length - 15} more lines)`));
          }
          console.log(c.dim('  ─────────────────────────────'));
          console.log('');
        } else {
          console.log('');
          console.log(c.bold(`  Issue #${idx + 1}: ${issue.title || issue.text}`));
          console.log(`  Severity: ${severityColor(issue.severity)}`);
          if (issue.description) console.log(`  ${issue.description}`);
          console.log('');
          console.log(c.yellow('  No automatic fix available for this issue.'));
          console.log(`  Try asking: ${c.cyan(`"how do I fix ${issue.title || issue.text}?"`)}`);
          console.log('');
        }
      }
      rl.prompt();
      return;
    }

    // apply <id> — legacy command, now same as fix <id>
    const applyMatch = input.match(/^apply\s+(\d+)$/i);
    if (applyMatch) {
      // Redirect to fix handler
      await handleInput(`fix ${applyMatch[1]}`);
      return;
    }

    // --- Natural language → send to /chat ---
    console.log('');
    busy = true;
    try {
      await streamChat(input, diagnosticId, conversationId, rl);
    } finally {
      busy = false;
    }
    console.log('');
    rl.prompt();
  }

  // --- Flush paste buffer as a single combined message ---
  function flushPasteBuffer() {
    pasteTimer = null;
    if (pasteBuffer.length === 0) return;

    // Combine all buffered lines into one message
    const combined = pasteBuffer.join('\n').trim();
    pasteBuffer = [];

    if (!combined) {
      rl.prompt();
      return;
    }

    // If the combined paste looks like a single command, handle as command
    const firstLine = combined.split('\n')[0].trim();
    if (combined.split('\n').length === 1 || /^(exit|quit|q|help|\?|scan|rescan|issues?|status|fix\s+\d+|apply\s+\d+)$/i.test(firstLine)) {
      handleInput(firstLine);
    } else {
      // Multi-line paste → send as one chat message
      handleInput(combined);
    }
  }

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    // If busy streaming, silently drop input
    if (busy) return;

    // Paste detection: buffer rapid lines and flush after a delay
    pasteBuffer.push(input);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(flushPasteBuffer, PASTE_DELAY_MS);
  });

  rl.on('close', () => {
    console.log('');
    console.log(c.cyan('🦞 ClawFix — made by Arca (arcabot.eth)'));
    console.log(c.cyan('   https://clawfix.dev'));
    console.log('');
    process.exit(0);
  });
}

// ============================================================
// TUI Rendering helpers
// ============================================================

function renderStatus(summary, issues, serverIssues) {
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('');
  console.log(c.cyan(`🦞 ClawFix v${VERSION}`));
  console.log(c.cyan('━'.repeat(48)));
  console.log('');
  console.log(c.bold('System Status:'));
  console.log(`  ${summary.gateway.icon} Gateway: ${summary.gateway.label}`);
  console.log(`  ${summary.config.icon} Config: ${summary.config.label}`);
  console.log(`  ${summary.issues.icon} ${summary.issues.label}`);
  console.log(`  ${c.green('✓')} Node: ${summary.node} | OS: ${summary.os}`);
  console.log('');

  renderIssues(issues, serverIssues);

  console.log(c.cyan('━'.repeat(48)));
  console.log(c.dim('  fix <#> | fix-all | scan | help | exit — or just type to chat'));
  console.log('');
}

function renderIssues(issues, serverIssues) {
  const all = mergeIssues(issues, serverIssues);

  if (all.length === 0) {
    console.log(c.green('  ✅ No issues detected — looking healthy!'));
    console.log('');
    return;
  }

  console.log(c.bold('Detected Issues:'));
  for (let i = 0; i < all.length; i++) {
    const issue = all[i];
    const sev = issue.severity || 'medium';
    const label = sev === 'critical' || sev === 'high'
      ? c.red(`[${sev.toUpperCase()}]`)
      : sev === 'medium'
        ? c.yellow(`[${sev.toUpperCase()}]`)
        : c.dim(`[${sev.toUpperCase()}]`);
    console.log(`  ${c.dim(`${i + 1}.`)} ${label} ${issue.title || issue.text}`);
  }
  console.log('');
}

function renderHelp() {
  console.log('');
  console.log(c.bold('Commands:'));
  console.log(`  ${c.cyan('fix <#>')}        Fix issue # (shows plan → confirm → apply → verify)`);
  console.log(`  ${c.cyan('fix-all')}        Fix all auto-fixable issues at once`);
  console.log(`  ${c.cyan('scan')}            Re-run diagnostics`);
  console.log(`  ${c.cyan('issues')}          Show detected issues`);
  console.log(`  ${c.cyan('status')}          Show system status`);
  console.log(`  ${c.cyan('help')}            Show this help`);
  console.log(`  ${c.cyan('exit')}            Quit ClawFix`);
  console.log('');
  console.log(c.bold('Chat:'));
  console.log(`  Just type naturally — e.g. ${c.dim('"my discord bot isn\'t responding"')}`);
  console.log(`  ClawFix AI will analyze using your diagnostic context.`);
  console.log('');
}

/**
 * Merge local CLI-detected issues with server-detected known issues.
 * Server issues (from known-issues.js pattern matching) include fix scripts.
 * Local issues are simpler {severity, text} objects.
 * Deduplicate by rough text matching.
 */
function mergeIssues(localIssues, serverIssues) {
  const merged = [];
  const seen = new Set();

  // Server issues first (they have fix scripts)
  if (serverIssues) {
    for (const si of serverIssues) {
      merged.push(si);
      seen.add((si.title || '').toLowerCase());
    }
  }

  // Then local issues that aren't duplicated
  for (const li of localIssues) {
    const key = (li.text || '').toLowerCase();
    const isDup = [...seen].some(s =>
      s.includes(key.slice(0, 20)) || key.includes(s.slice(0, 20))
    );
    if (!isDup) {
      merged.push(li);
    }
  }

  return merged;
}

function severityColor(sev) {
  if (sev === 'critical') return c.red(c.bold('CRITICAL'));
  if (sev === 'high') return c.red('HIGH');
  if (sev === 'medium') return c.yellow('MEDIUM');
  return c.dim('LOW');
}

// ============================================================
// Chat streaming — SSE from /api/chat
// ============================================================
async function streamChat(message, diagnosticId, conversationId, rl) {
  // Pause readline so it doesn't interfere with output
  rl.pause();

  process.stdout.write(c.dim('  thinking...'));

  try {
    const resp = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diagnosticId, message, conversationId }),
    });

    // Non-SSE fallback (e.g. AI not available)
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await resp.json();
      // Clear "thinking..."
      process.stdout.write('\r\x1b[K');
      if (data.error) {
        console.log(c.red(`  ${data.error}`));
      } else {
        wrapPrint(data.response || 'No response from AI.');
      }
      rl.resume();
      return;
    }

    // SSE streaming — collect full response, then render
    // Buffer approach: collect content chunks, flush periodically for progressive display
    process.stdout.write('\r\x1b[K');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let contentBuffer = ''; // accumulate content between flushes
    let col = 2; // Current column (2 for indent)
    let started = false; // whether we've written any content yet
    let hadError = false;

    // Flush accumulated content to screen
    function flushContent() {
      if (!contentBuffer) return;
      if (!started) {
        process.stdout.write('  ');
        started = true;
      }
      for (const ch of contentBuffer) {
        if (ch === '\n') {
          process.stdout.write('\n  ');
          col = 2;
        } else {
          process.stdout.write(ch);
          col++;
          if (col > 76 && ch === ' ') {
            process.stdout.write('\n  ');
            col = 2;
          }
        }
      }
      contentBuffer = '';
    }

    // Set up periodic flush (every 50ms) for smooth progressive rendering
    const flushInterval = setInterval(flushContent, 50);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              flushContent();
              process.stdout.write(c.red(parsed.error));
              hadError = true;
              break;
            }
            if (parsed.content) {
              contentBuffer += parsed.content;
            }
          } catch {}
        }
        if (hadError) break;
      }
    } finally {
      clearInterval(flushInterval);
    }

    // Final flush of any remaining content
    flushContent();
    if (started || hadError) {
      process.stdout.write('\n');
    }
  } catch (err) {
    process.stdout.write('\r\x1b[K');
    if (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED') {
      console.log(c.yellow('  ClawFix server is unreachable. Chat requires an internet connection.'));
      console.log(c.dim('  Local commands still work: fix <#>, apply <#>, scan, issues'));
    } else {
      console.log(c.red(`  Connection error: ${err.message}`));
    }
  }

  rl.resume();
}

/**
 * Print text with 2-space indent and word wrapping.
 */
function wrapPrint(text) {
  const width = 76;
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      console.log('');
      continue;
    }
    const words = paragraph.split(' ');
    let line = '  ';
    for (const word of words) {
      if (line.length + word.length + 1 > width && line.trim()) {
        console.log(line);
        line = '  ';
      }
      line += (line.trim() ? ' ' : '') + word;
    }
    if (line.trim()) console.log(line);
  }
}

// ============================================================
// Main entry point
// ============================================================
async function main() {
  if (SHOW_VERSION) {
    console.log(`clawfix v${VERSION}`);
    return;
  }

  if (SHOW_HELP) {
    console.log(`
🦞 ClawFix v${VERSION} — AI-Powered OpenClaw Diagnostic

Usage: npx clawfix [options]

Modes:
  (default)            Interactive TUI — scan + chat + fix
  --scan               One-shot scan (legacy mode)
  --no-interactive     Same as --scan

Options:
  --dry-run, -n    Scan locally only — shows what would be collected, sends nothing
  --show-data, -d  Display the full diagnostic payload before asking to send
  --yes, -y        Skip confirmation prompt and send automatically
  --version, -v    Show version
  --help, -h       Show this help message

Environment:
  CLAWFIX_API      Override API URL (default: https://clawfix.dev)
  CLAWFIX_AUTO=1   Same as --yes

Interactive Commands:
  fix <#>          Fix issue (shows plan → confirm → apply → verify)
  fix-all          Fix all auto-fixable issues at once
  scan             Re-run diagnostics
  issues           Show detected issues
  help             Show help
  exit             Quit

  Or just type naturally to chat with ClawFix AI.

Security:
  • All API keys, tokens, and passwords are automatically redacted
  • Your hostname is SHA-256 hashed (only first 8 chars sent)
  • No file contents are read (only existence checks)
  • Nothing is sent without your explicit approval (unless --yes)
  • Source code: https://github.com/arcabotai/clawfix

Examples:
  npx clawfix                  # Interactive TUI (default)
  npx clawfix --scan           # One-shot scan + AI analysis
  npx clawfix --dry-run        # See what data would be collected
  npx clawfix --yes --scan     # Auto-send for CI/scripting
`);
    return;
  }

  if (ONE_SHOT) {
    await runOneShotMode();
  } else {
    await runInteractiveMode();
  }
}

main().catch(err => {
  console.error(c.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
