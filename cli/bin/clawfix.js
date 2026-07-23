#!/usr/bin/env node

/**
 * ClawFix CLI: OpenClaw diagnostics and guarded repairs
 * https://clawfix.dev
 *
 * Usage: npx clawfix          (interactive TUI)
 *        npx clawfix --scan   (one-shot scan, legacy mode)
 */

import { readFileSync } from 'node:fs';
import { readFile, writeFile, copyFile, rename, access, readdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir, platform, arch, release, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  collectListeningPort,
  collectNativeConfigValidation,
  collectNativeDoctor,
  collectNativeSecurityAudit,
  collectNativeStatus,
  collectOpenClawVersion,
} from './native-diagnostics.js';
import { projectLocalIssuesForUpload, redactOutbound } from './security.js';
import { countMarkdownFiles } from './workspace.js';
import { openClawAdapter } from '../adapters/openclaw.js';
import { resolveCliMode } from '../core/modes.js';
import { parseCliOptions } from '../core/options.js';

// --- Config ---
const CLI_OPTIONS = parseCliOptions(process.argv.slice(2), process.env);
const CLI_MODE = resolveCliMode(CLI_OPTIONS);
const {
  apiUrl: API_URL,
  apiToken: API_TOKEN,
  showData: SHOW_DATA,
  autoSend: AUTO_SEND,
  jsonOnly: JSON_ONLY,
  localOnly: LOCAL_ONLY,
} = CLI_OPTIONS;
const API_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
});
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.9.1';
  }
})();

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
  const copy = { ...config };
  delete copy.env;
  return redactOutbound(copy);
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
    description: 'Review the process occupying the gateway port',
    risk: 'medium',
    needsConfig: false,
    needsRestart: false,
    informational: true,
    apply: () => ({ changes: ['No process stopped; review the listener evidence first'] })
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

  const openclawBin = await openClawAdapter.findExecutable() || '';

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
  const npmVersion = await openClawAdapter.npmVersion({ timeoutMs: 5000 });
  const hostHash = hashStr(hostname());

  const versionResult = openclawBin
    ? await openClawAdapter.version({
      executable: openclawBin,
      timeoutMs: 10_000,
      maxStdoutBytes: 1_200,
      maxStderrBytes: 4_000,
    })
    : null;
  const versionProbe = versionResult
    ? collectOpenClawVersion(openclawBin, () => versionResult)
    : { version: '', runtimeCompatible: false, error: 'OpenClaw binary not found' };
  const ocVersion = versionProbe.version;

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
    gatewayStatus = await openClawAdapter.gatewayStatusText({
      executable: openclawBin,
      timeoutMs: 5000,
    }) || 'could not check';
  }

  const gatewayPort = config?.gateway?.port || 18789;
  const gatewayPid = await openClawAdapter.gatewayProcesses({ timeoutMs: 5000 });

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
      const tailContent = (await openClawAdapter.readFileTail(logPath, {
        maxLines: 500,
        maxBytes: 1024 * 1024,
      })).text;
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
      stderrLogs = (await openClawAdapter.readFileTail(errLogPath, {
        maxLines: 200,
        maxBytes: 1024 * 1024,
      })).text;
      const icon = errLogSizeMB > 50 ? c.yellow('⚠️') : c.green('✅');
      log(`   ${icon} Error log found (${errLogSizeMB}MB${errLogSizeMB > 50 ? ' — OVERSIZED!' : ''})`);
    } catch {}
  }

  // --- Service Health ---
  log('');
  log(c.blue('🔧 Checking service health...'));

  const serviceHealth = await openClawAdapter.serviceManagerState({ timeoutMs: 5000 });
  const isMac = osName === 'darwin';
  const isLinux = osName === 'linux';

  if (isMac) {
    if (serviceHealth.manager === 'launchd') {
      const runsIcon = serviceHealth.runs > 2 ? c.yellow('⚠️') : c.green('✅');
      log(`   ${runsIcon} LaunchAgent: ${serviceHealth.state} (${serviceHealth.runs} run(s), PID ${serviceHealth.pid || 'none'})`);
      if (serviceHealth.uptimeStr) log(`   Uptime: ${serviceHealth.uptimeStr}`);
      if (serviceHealth.runs > 2) log(c.yellow(`   ⚠️  Multiple restarts detected — possible crash loop`));
    } else {
      log(c.dim('   LaunchAgent not found'));
    }
  } else if (isLinux) {
    if (serviceHealth.manager === 'systemd') {
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
      mdFiles = await countMarkdownFiles(workspaceDir);
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
  const portEvidence = {};
  const checkPort = (port, name) => {
    const evidence = collectListeningPort(port);
    portEvidence[port] = evidence;
    if (!evidence.valid) {
      log(c.red(`   ❌ Port ${String(port)} (${name}) — invalid configuration`));
      portResults[port] = false;
      return false;
    }
    if (evidence.available === false) {
      log(c.yellow(`   ⚠️  Port ${port} (${name}) — could not inspect`));
      portResults[port] = null;
      return null;
    }
    if (evidence.listening) {
      const owner = evidence.process && evidence.pid
        ? ` by ${evidence.process} (PID ${evidence.pid})`
        : '';
      log(c.yellow(`   ⚠️  Port ${port} (${name}) — IN USE${owner}`));
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

  // --- Native OpenClaw Doctor (read-only structured findings) ---
  log('');
  log(c.blue('🩺 Running OpenClaw native health checks...'));
  const nativeDoctor = openclawBin
    ? collectNativeDoctor(openclawBin)
    : { available: false, checksRun: 0, checksSkipped: 0, findings: [] };
  if (nativeDoctor.available) {
    const icon = nativeDoctor.findings.length > 0 ? c.yellow('⚠️') : c.green('✅');
    log(`   ${icon} Doctor: ${nativeDoctor.checksRun} checks, ${nativeDoctor.findings.length} relevant finding(s)`);
  } else {
    log(c.dim('   Native Doctor JSON unavailable on this OpenClaw version'));
  }

  const canRunNativeEvidence = Boolean(openclawBin && versionProbe.runtimeCompatible);
  const nativeConfig = canRunNativeEvidence
    ? collectNativeConfigValidation(openclawBin)
    : { available: false, valid: null, warnings: [], errors: [] };
  const nativeStatus = canRunNativeEvidence
    ? collectNativeStatus(openclawBin)
    : { available: false };
  const nativeSecurity = canRunNativeEvidence
    ? collectNativeSecurityAudit(openclawBin)
    : { available: false, findings: [] };

  if (nativeConfig.available) {
    const icon = nativeConfig.valid === true ? c.green('✅') :
      nativeConfig.valid === false ? c.red('❌') : c.yellow('⚠️');
    const label = nativeConfig.valid === true ? 'valid' :
      nativeConfig.valid === false ? 'invalid' : 'unknown';
    log(`   ${icon} Config schema: ${label}`);
  }
  if (nativeStatus.available) {
    const icon = nativeStatus.gateway.reachable ? c.green('✅') : c.yellow('⚠️');
    log(`   ${icon} Gateway reachability: ${nativeStatus.gateway.reachable ? 'reachable' : 'unreachable'}`);
  }
  if (nativeSecurity.available) {
    const critical = nativeSecurity.summary.critical;
    const warning = nativeSecurity.summary.warning;
    const icon = critical > 0 ? c.red('❌') : warning > 0 ? c.yellow('⚠️') : c.green('✅');
    log(`   ${icon} Security audit: ${critical} critical, ${warning} warning`);
  }

  // --- Local Issue Detection ---
  const issues = [];
  const gatewayPortFinding = portEvidence[gatewayPort]?.finding;
  if (gatewayPortFinding) {
    issues.push({
      severity: 'high',
      kind: 'failure',
      text: gatewayPortFinding.message,
      source: 'clawfix-port-probe',
      nativeCheckId: gatewayPortFinding.checkId,
      path: gatewayPortFinding.path,
    });
  }
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
  const expectedCodexHome = openclawDir ? join(openclawDir, 'codex-home') : join(home, '.openclaw', 'codex-home');
  const shellCodexHomeSet = Boolean(process.env.CODEX_HOME);
  const shellCodexHomeMatchesExpected = process.env.CODEX_HOME === expectedCodexHome;
  const combinedLogs = [errorLogs, stderrLogs, gatewayLogTail, gatewayStatus].filter(Boolean).join('\n');

  const gatewayRunning = /running.*pid|state active|listening/i.test(gatewayStatus);
  const gatewayFailed = /not running|failed to start|stopped|inactive/i.test(gatewayStatus);
  const listenerPid = Number(portEvidence[gatewayPort]?.pid);
  const expectedGatewayPid = Number.parseInt(String(gatewayPid || ''), 10);
  const competingPortOwner = portEvidence[gatewayPort]?.listening === true &&
    Number.isSafeInteger(listenerPid) && listenerPid > 0 && (
      (Number.isSafeInteger(expectedGatewayPid) && expectedGatewayPid > 0 && listenerPid !== expectedGatewayPid) ||
      !gatewayPid
    );
  if ((gatewayFailed || (!gatewayRunning && !/warning/i.test(gatewayStatus))) && !competingPortOwner) {
    issues.push({ severity: 'critical', text: 'Gateway is not running' });
  }
  if (competingPortOwner) {
    issues.push({ severity: 'critical', text: 'Port conflict detected' });
  }
  if (versionProbe.runtimeCompatible === false && versionProbe.runtimeRequired) {
    issues.push({
      severity: 'critical',
      text: `OpenClaw requires Node ${versionProbe.runtimeRequired} (current: ${versionProbe.runtimeCurrent || nodeVersion})`,
      source: 'openclaw-runtime',
    });
  }
  if ((config?.plugins?.load?.paths || []).some(path => (
    typeof path === 'string' && /openclaw\/dist\/extensions\//.test(path)
  )) || /ignored plugins\.load\.paths entry.*bundled plugin directory/i.test(combinedLogs)) {
    issues.push({ severity: 'medium', text: 'Stale bundled plugin load paths configured' });
  }
  if (codexPluginEnabled && (activeModelRefs.some(ref => String(ref).startsWith('openai-codex/')) || hasPiFallback)) {
    issues.push({ knownIssueId: 'pi-backed-openai-codex-route', severity: 'high', text: 'PI-backed openai-codex route active instead of native Codex harness' });
  }
  if (/Codex cannot access session files.*\.codex[\/\\]sessions|Operation not permitted.*\.codex[\/\\]sessions|permission denied.*\.codex[\/\\]sessions/i.test(combinedLogs)) {
    issues.push({ knownIssueId: 'codex-session-store-permission', severity: 'high', text: 'Codex session-store permission failure' });
  }
  if (codexPluginEnabled && hasNativeCodexRuntime && !shellCodexHomeMatchesExpected) {
    issues.push({ knownIssueId: 'codex-shell-home-mismatch', severity: 'medium', text: 'Shell CODEX_HOME does not match OpenClaw Codex home' });
  }
  if (codexPluginEnabled &&
      (hasNativeCodexRuntime || activeModelRefs.some(ref => String(ref).startsWith('openai/'))) &&
      codexAppServer.serviceTier !== 'fast') {
    issues.push({ knownIssueId: 'codex-service-tier-not-fast', severity: 'low', kind: 'optimization', text: 'Codex app-server fast tier is not enabled' });
  }
  const codexRequestTimeoutMs = Number(codexAppServer.requestTimeoutMs ?? 60000);
  const activeMemoryTimeoutMs = Number(config?.plugins?.entries?.['active-memory']?.config?.timeoutMs ?? NaN);
  const codexTimeoutSymptoms =
    /EMBEDDED FALLBACK: Gateway agent failed|gateway closed \((1006|1012)\)|codex app-server startup aborted/i.test(combinedLogs) ||
    /active-memory:.*status=timeout|lane=.*active-memory.*durationMs=\d+.*codex app-server startup aborted/i.test(combinedLogs);
  if (codexPluginEnabled &&
      hasNativeCodexRuntime &&
      codexTimeoutSymptoms &&
      (codexRequestTimeoutMs <= 60000 || activeMemoryTimeoutMs <= 60000)) {
    issues.push({ knownIssueId: 'native-codex-timeout-boundary', severity: 'high', text: 'Native Codex timeout boundary can force gateway fallback' });
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
  if (config?.agents?.defaults && !config.agents.defaults.memorySearch?.query?.hybrid?.enabled) {
    issues.push({ severity: 'medium', kind: 'optimization', text: 'Hybrid search not enabled (recommended)' });
  }
  if (config?.agents?.defaults && !config.agents.defaults.contextPruning) {
    issues.push({ severity: 'medium', kind: 'optimization', text: 'No context pruning configured' });
  }
  if (config?.agents?.defaults && !config.agents.defaults.compaction?.memoryFlush?.enabled) {
    issues.push({ severity: 'medium', kind: 'optimization', text: 'Memory flush not enabled (data loss on compaction)' });
  }
  if (!hasSoul && workspaceDir) {
    issues.push({ severity: 'low', kind: 'optimization', text: 'No SOUL.md found (agent has no personality)' });
  }
  if (memoryFiles === 0 && workspaceDir) {
    issues.push({ severity: 'low', kind: 'optimization', text: 'No memory files found' });
  }

  if (nativeConfig.available && nativeConfig.valid === false) {
    issues.push({
      severity: 'high',
      text: nativeConfig.errors[0]?.message || 'OpenClaw config schema validation failed',
      source: 'openclaw-config',
      nativeCheckId: 'config/schema-invalid',
      path: nativeConfig.errors[0]?.path || null,
    });
  }

  if (
    nativeStatus.available &&
    nativeStatus.gateway.reachable === false &&
    !issues.some(issue => /gateway.*not running|gateway.*unreachable/i.test(issue.text))
  ) {
    issues.push({
      severity: 'critical',
      text: nativeStatus.gateway.error || 'OpenClaw gateway is unreachable',
      source: 'openclaw-status',
      nativeCheckId: 'status/gateway-unreachable',
    });
  }

  if (
    competingPortOwner &&
    nativeStatus.available &&
    nativeStatus.gateway.reachable === false
  ) {
    const owner = portEvidence[gatewayPort].process;
    const pid = portEvidence[gatewayPort].pid;
    issues.push({
      severity: 'critical',
      text: `Gateway port ${gatewayPort} is occupied${owner ? ` by ${owner}` : ''}${pid ? ` (PID ${pid})` : ''}, but OpenClaw cannot reach it`,
      source: 'clawfix-port-probe',
      nativeCheckId: 'runtime/gateway-port-conflict',
    });
  }

  for (const finding of nativeSecurity.findings) {
    if (finding.severity === 'info') continue;
    issues.push({
      severity: finding.severity === 'critical' ? 'critical' :
        finding.severity === 'error' ? 'high' : 'medium',
      text: finding.title || finding.message,
      description: finding.message,
      source: finding.source,
      nativeCheckId: finding.checkId,
      path: finding.path,
      fixHint: finding.fixHint,
    });
  }

  for (const finding of nativeDoctor.findings) {
    const duplicate = issues.some(issue => (
      issue.nativeCheckId === finding.checkId ||
      issue.text.toLowerCase() === finding.message.toLowerCase()
    ));
    if (duplicate) continue;
    issues.push({
      severity: finding.severity === 'error' ? 'high' : 'medium',
      text: finding.message,
      source: 'openclaw-doctor',
      nativeCheckId: finding.checkId,
      path: finding.path,
      fixHint: finding.fixHint,
    });
  }

  for (const issue of issues) {
    if (!issue.kind) {
      issue.kind = issue.severity === 'critical' || issue.severity === 'high'
        ? 'failure'
        : 'warning';
    }
  }

  // --- Build Payload ---
  const diagnostic = redactOutbound({
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
      configExists: config !== null,
      gatewayStatus,
      gatewayPid: gatewayPid || 'none',
      gatewayPort,
      processExists: Boolean(gatewayPid),
      portListening: portResults[gatewayPort] === true,
      runtimeCompatible: versionProbe.runtimeCompatible,
      runtimeRequired: versionProbe.runtimeRequired,
      runtimeCurrent: versionProbe.runtimeCurrent,
    },
    config: sanitizedConfig,
    nativeConfig,
    nativeDoctor,
    nativeStatus,
    nativeSecurity,
    ports: {
      gateway: { port: gatewayPort, ...portEvidence[gatewayPort] },
      browserCdp: { port: 18800, ...portEvidence[18800] },
      browserControl: { port: 18791, ...portEvidence[18791] },
    },
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
      exists: Boolean(workspaceDir && await exists(workspaceDir)),
      mdFiles,
      memoryFiles,
      hasSoul,
      hasAgents,
    },
    browser: {
      status: openclawDir && await exists(join(openclawDir, 'browser')) ? 'configured' : 'not configured',
    },
    codex: {
      expectedHome: expectedCodexHome,
      shellCodexHomeSet,
      shellCodexHomeMatchesExpected,
    },
  });

  // Build summary for TUI display
  const gatewayIcon = gatewayRunning ? c.green('✓') : c.red('✗');
  const gatewayLabel = gatewayRunning
    ? `running (pid ${gatewayPid || '?'}, port ${gatewayPort})`
    : 'not running';
  const configIcon = config ? c.green('✓') : c.yellow('⚠');
  const configLabel = config ? 'loaded' : 'not found';
  const actionableIssueCount = issues.filter(issue => issue.kind !== 'optimization').length;
  const optimizationCount = issues.length - actionableIssueCount;
  const issueIcon = actionableIssueCount === 0 ? c.green('✓') : c.yellow('⚠');
  const issueLabel = actionableIssueCount === 0
    ? optimizationCount > 0 ? `Healthy; ${optimizationCount} optimization(s)` : 'No issues'
    : `${actionableIssueCount} issue(s), ${optimizationCount} optimization(s)`;

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
  if (JSON_ONLY) {
    const result = await collectDiagnostics({ quiet: true });
    if (result.error) {
      console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({
      ok: true,
      diagnostic: result.diagnostic,
      issues: result.issues,
    }, null, 2));
    return;
  }

  console.log('');
  console.log(c.cyan(`🦞 ClawFix v${VERSION}: OpenClaw Diagnostics and Guarded Repairs`));
  if (LOCAL_ONLY) console.log(c.yellow('   🔍 LOCAL-ONLY MODE — nothing will be sent'));
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  const result = await collectDiagnostics();

  if (result.error) {
    console.log(c.red(`❌ ${result.error}`));
    console.log('Make sure OpenClaw is installed: https://openclaw.ai');
    process.exit(1);
  }

  const { diagnostic, issues } = result;
  const actionableIssues = issues.filter(issue => issue.kind !== 'optimization');
  const optimizations = issues.filter(issue => issue.kind === 'optimization');

  // --- Display issues ---
  console.log('');
  console.log(c.cyan('━'.repeat(50)));
  console.log(c.bold('📊 Diagnostic Summary'));
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  if (actionableIssues.length === 0) {
    console.log(c.green('✅ No issues detected! Your OpenClaw looks healthy.'));
  } else {
    console.log(c.red(`Found ${actionableIssues.length} issue(s):`));
    console.log('');
    for (const issue of actionableIssues) {
      const icon = issue.severity === 'critical' ? c.red('❌') :
                   issue.severity === 'high' ? c.red('❌') :
                   c.yellow('⚠️');
      console.log(`   ${icon} [${issue.severity.toUpperCase()}] ${issue.text}`);
    }
  }

  if (optimizations.length > 0) {
    console.log('');
    console.log(c.blue(`Optional optimizations (${optimizations.length}):`));
    for (const issue of optimizations) {
      console.log(`   ${c.blue('💡')} ${issue.text}`);
    }
  }

  console.log('');
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  // --- Show collected data ---
  if (LOCAL_ONLY || SHOW_DATA) {
    console.log('');
    console.log(c.bold('📦 Data that would be sent:'));
    console.log(c.cyan('━'.repeat(50)));
    console.log(JSON.stringify(diagnostic, null, 2));
    console.log(c.cyan('━'.repeat(50)));
    console.log('');
  }

  if (LOCAL_ONLY) {
    console.log(c.yellow('🔍 Local scan complete — nothing was sent.'));
    console.log('');
    console.log('To send this data for AI analysis:');
    console.log(c.cyan('  npx clawfix'));
    console.log('');
    console.log(c.cyan('🦞 ClawFix — made by Arca (arcabot.eth)'));
    console.log(c.cyan('   https://clawfix.dev | https://x.com/arcabotai'));
    console.log('');
    return;
  }

  if (actionableIssues.length === 0) {
    console.log(c.green('Your OpenClaw is looking good! No repairs needed.'));
    if (optimizations.length > 0) {
      console.log(`${optimizations.length} optional optimization(s) were listed above.`);
    }
    console.log(`If you're still having issues, run with --show-data to see what would be collected.`);
    console.log('');
    console.log(c.cyan(`🦞 ClawFix — made by Arca (arcabot.eth)`));
    console.log(c.cyan(`   https://clawfix.dev | https://x.com/arcabotai`));
    console.log('');
    return;
  }

  console.log('Optional AI analysis can explain problems that deterministic checks do not cover.');
  console.log('');
  console.log(c.dim('Data recipient: ClawFix and OpenRouter (AI analysis provider)'));
  console.log(c.dim('Data sent:      OS, versions, OpenClaw config (recognized secrets redacted), error logs'));
  console.log(c.dim('Data omitted:   Top-level config env block, workspace documents, chat history, real hostname'));
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
      headers: API_HEADERS,
      body: JSON.stringify(redactOutbound(diagnostic)),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const fixId = result.fixId;

    console.log('');
    console.log(c.green(`✅ Diagnosis complete! Found ${result.issuesFound} issue(s) and ${result.optimizationsFound || 0} optimization(s).`));
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
    console.log('Review the diagnostic locally or retry with a custom server:');
    console.log(c.cyan('  npx clawfix --dry-run'));
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
  let sendConsent = AUTO_SEND;

  async function uploadDiagnostic() {
    if (!sendConsent) return;
    const payload = redactOutbound({
      ...diagnostic,
      _localIssues: projectLocalIssuesForUpload(issues),
    });
    const resp = await fetch(`${API_URL}/api/diagnose`, {
      method: 'POST',
      headers: API_HEADERS,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    diagnosticId = data.fixId;
    serverIssues = data.knownIssues || [];
  }

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

  // Explicit consent is required before the first upload. This decision is
  // retained for manual rescans and post-repair verification scans.
  if (!sendConsent) {
    console.log(c.dim('Optional AI analysis sends the redacted diagnostic to ClawFix and OpenRouter.'));
    const consentRl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      consentRl.question('Send redacted diagnostic for AI analysis? [y/N] ', resolve);
    });
    consentRl.close();
    sendConsent = /^y(es)?$/i.test(answer.trim());
  }

  if (sendConsent) {
    try {
      await uploadDiagnostic();
    } catch {
      // Server unavailable — continue in local-only mode without changing consent.
    }
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

        // Preserve the startup consent decision for rescans.
        if (sendConsent) {
          try { await uploadDiagnostic(); } catch {}
        }
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
          // Preserve the startup consent decision for post-fix rescans.
          if (sendConsent) {
            try { await uploadDiagnostic(); } catch {}
          }
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
              if (sendConsent) {
                try { await uploadDiagnostic(); } catch {}
              }
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
    if (!sendConsent) {
      console.log('');
      console.log(c.yellow('  AI chat is local-only until you restart and explicitly opt in to upload.'));
      console.log(c.dim('  Local commands still work: fix <#>, fix-all, scan, issues'));
      console.log('');
      rl.prompt();
      return;
    }
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

  console.log(c.bold('Findings:'));
  for (let i = 0; i < all.length; i++) {
    const issue = all[i];
    const sev = issue.severity || 'medium';
    const label = issue.kind === 'optimization'
      ? c.blue('[OPTIONAL]')
      : sev === 'critical' || sev === 'high'
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
  console.log('  If AI is enabled on the selected server, ClawFix can analyze your diagnostic context.');
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
      headers: API_HEADERS,
      body: JSON.stringify({ diagnosticId, message, conversationId }),
      signal: AbortSignal.timeout(95_000),
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
  if (CLI_MODE.kind === 'version') {
    console.log(`clawfix v${VERSION}`);
    return;
  }

  if (CLI_MODE.kind === 'help') {
    console.log(`
🦞 ClawFix v${VERSION}: OpenClaw diagnostics and guarded repairs

Usage: npx clawfix [options]

Modes:
  (default)            Interactive TUI: scan, review, fix, and optional chat
  --scan               One-shot scan (legacy mode)
  --no-interactive     Same as --scan

Options:
  --dry-run, -n    Scan locally only — shows what would be collected, sends nothing
  --no-send        Local-only scan; never uploads (alias: --local-only)
  --json           Machine-readable local scan; sends nothing
  --show-data, -d  Display the full diagnostic payload before asking to send
  --server URL     Use a custom ClawFix API server (http or https)
  --yes, -y        Skip confirmation prompt and send automatically
  --version, -v    Show version
  --help, -h       Show this help message

Environment:
  CLAWFIX_API      Override API URL (default: https://clawfix.dev)
  CLAWFIX_API_TOKEN  Optional bearer token for a protected ClawFix server
  CLAWFIX_AUTO=1   Same as --yes

Interactive Commands:
  fix <#>          Fix issue (shows plan → confirm → apply → verify)
  fix-all          Fix all auto-fixable issues at once
  scan             Re-run diagnostics
  issues           Show detected issues
  help             Show help
  exit             Quit

  AI analysis is optional and only works when enabled on the selected server.

Security:
  • Recognized API keys, tokens, and passwords are redacted; inspect --dry-run before upload
  • Your hostname is SHA-256 hashed (only first 8 chars sent)
  • Workspace documents are checked by existence only; config and matching error lines may be collected
  • ClawFix discloses OpenRouter and asks before the first upload (unless --yes)
  • Source code: https://github.com/arcabotai/clawfix

Examples:
  npx clawfix                  # Interactive TUI (default)
  npx clawfix --scan           # One-shot scan + repair guidance
  npx clawfix --dry-run        # See what data would be collected
  npx clawfix --yes --scan     # Auto-send for CI/scripting
`);
    return;
  }

  if (CLI_MODE.kind === 'error') {
    console.error(CLI_MODE.error.message);
    process.exitCode = CLI_MODE.error.exitCode;
    return;
  }

  if (CLI_MODE.kind === 'one-shot') {
    await runOneShotMode();
  } else {
    await runInteractiveMode();
  }
}

main().catch(err => {
  console.error(c.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
