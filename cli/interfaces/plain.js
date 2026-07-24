/**
 * ClawFix plain interface — Node 18+ text UI over the shared diagnostic/session core.
 * Renders session and scan events as plain terminal output (no OpenTUI).
 */

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
} from '../bin/native-diagnostics.js';
import { projectLocalIssuesForUpload, redactOutbound } from '../bin/security.js';
import { countMarkdownFiles } from '../bin/workspace.js';
import { openClawAdapter } from '../adapters/openclaw.js';
import { createDiagnosticsCore } from '../core/diagnostics.js';
import { dedupeFindingsForDisplay, normalizeFindings } from '../core/findings.js';
import { repairCatalog } from '../core/repair-catalog.js';
import { createRepairEngine } from '../core/repair-engine.js';
import { createSessionController } from '../core/session.js';
import { createOfflineAnalyzer } from '../core/offline-analyzer.js';

// --- Runtime options (injected by entrypoint) ---
let API_URL;
let API_TOKEN;
let SHOW_DATA;
let AUTO_SEND;
let JSON_ONLY;
let LOCAL_ONLY;
let API_HEADERS;
let VERSION;
let MODE;

function configurePlainRuntime(options = {}, { version, mode } = {}) {
  API_URL = options.apiUrl;
  API_TOKEN = options.apiToken || '';
  SHOW_DATA = Boolean(options.showData);
  AUTO_SEND = Boolean(options.autoSend);
  JSON_ONLY = Boolean(options.jsonOnly);
  LOCAL_ONLY = Boolean(options.localOnly);
  API_HEADERS = Object.freeze({
    'Content-Type': 'application/json',
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
  });
  VERSION = version;
  MODE = mode;
}

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

const repairEngine = createRepairEngine({ catalog: repairCatalog });

async function applyCatalogRepair(issue, rl, session) {
  const proposal = session.proposeRepair(issue.id);
  if (proposal.status !== 'proposed') {
    console.log(c.yellow(`  Repair unavailable: ${proposal.status}`));
    return proposal;
  }
  const { plan } = proposal;
  const preview = await repairEngine.previewPlan(plan, {});

  console.log('');
  console.log(c.bold(`  Fix: ${issue.title}`));
  console.log(`  ${c.dim(plan.description)}`);
  console.log(`  Risk: ${plan.risk === 'low' ? c.green('low') : c.yellow(plan.risk)}`);
  console.log('');
  console.log(c.bold('  Plan:'));
  for (const [index, step] of preview.steps.entries()) {
    console.log(`    ${index + 1}. ${step}`);
  }
  console.log('');

  const answer = await new Promise(resolve => {
    rl.question(`  ${c.yellow('Apply?')} [y/N] `, resolve);
  });
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(c.dim('  Cancelled.'));
    console.log('');
    return { status: 'cancelled' };
  }

  const result = await session.applyRepair({
    planId: plan.planId,
    approvalToken: plan.approvalToken,
    findingId: issue.id,
    ctx: {
      openclaw: openClawAdapter,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    },
  });

  if (result.status === 'applied') {
    console.log(`  ${c.green('✅')} Gateway restarted and verified.`);
  } else if (result.status === 'verify_failed') {
    console.log(`  ${c.yellow('⚠️')} Restart ran, but the gateway is still unavailable.`);
  } else if (result.status === 'blocked') {
    console.log(`  ${c.dim('ℹ️')} Repair no longer needed: ${result.reason}`);
  } else if (result.status === 'rejected') {
    console.log(`  ${c.yellow('⚠️')} Repair plan rejected: ${result.reason}`);
  } else {
    console.log(`  ${c.red('❌')} Repair failed: ${result.error || result.status}`);
  }
  console.log('');
  return result;
}

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
        const stillPresent = allAfter.some(candidate => candidate.id === issue.id);

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
  const fixable = allIssues.filter(i => BUILTIN_FIXES[i.repairId] && !BUILTIN_FIXES[i.repairId].informational);

  if (fixable.length === 0) {
    console.log(c.dim('  No auto-fixable issues found.'));
    return null;
  }

  console.log('');
  console.log(c.bold(`  Fix plan (${fixable.length} issues):`));
  for (const issue of fixable) {
    const fix = BUILTIN_FIXES[issue.repairId];
    const risk = fix.risk === 'low' ? c.green('low') : c.yellow(fix.risk);
    console.log(`    ${c.blue('🔧')} [${risk}] ${issue.title || issue.text}`);
    console.log(`       ${c.dim(fix.description)}`);
  }

  const skipped = allIssues.filter(i => BUILTIN_FIXES[i.repairId]?.informational);
  if (skipped.length) {
    console.log('');
    for (const issue of skipped) {
      console.log(`    ${c.dim(`ℹ️  [SKIP] ${issue.title || issue.text} — informational`)}`);
    }
  }

  const noFix = allIssues.filter(i => !BUILTIN_FIXES[i.repairId] && !i.fix);
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
    const fix = BUILTIN_FIXES[issue.repairId];
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
// Diagnostic core compatibility bridge
// ============================================================
function createCliDiagnosticsCore() {
  return createDiagnosticsCore({
    version: VERSION,
    redact: redactOutbound,
    fs: {
      exists,
      readJson,
      stat,
      readdir,
      countMarkdownFiles,
    },
    openclaw: openClawAdapter,
    os: {
      homedir,
      platform,
      release,
      arch,
      hostname,
      nodeVersion: () => process.version,
    },
    env: { ...process.env },
    clock: { now: () => new Date() },
    createHash,
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: handle => clearTimeout(handle),
    },
    nativeCollectors: {
      collectOpenClawVersion,
      collectListeningPort,
      collectNativeDoctor,
      collectNativeConfigValidation,
      collectNativeStatus,
      collectNativeSecurityAudit,
    },
  });
}

let diagnosticsCore;
function getDiagnosticsCore() {
  if (!diagnosticsCore) diagnosticsCore = createCliDiagnosticsCore();
  return diagnosticsCore;
}

function renderScanEvent(event, log) {
  if (event.type !== 'scan.step') return;
  log(c.blue(`🔎 ${event.label}...`));
}

function legacySummary(summary) {
  return {
    gateway: {
      icon: summary.gateway.running ? c.green('✓') : c.red('✗'),
      label: summary.gateway.label,
    },
    config: {
      icon: summary.config.loaded ? c.green('✓') : c.yellow('⚠'),
      label: summary.config.label,
    },
    issues: {
      icon: summary.issues.actionable === 0 ? c.green('✓') : c.yellow('⚠'),
      label: summary.issues.label,
    },
    node: summary.node,
    os: summary.os,
    ocVersion: summary.ocVersion,
  };
}

async function collectDiagnostics({ quiet = false, signal } = {}) {
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const result = await getDiagnosticsCore().runDiagnostics({
    revision: randomUUID(),
    signal,
    emit: event => renderScanEvent(event, log),
  });
  if (result.error) {
    return {
      error: result.error,
      errorCode: result.errorCode || null,
    };
  }
  return {
    revision: result.revision,
    diagnostic: result.diagnostic,
    issues: result.issues,
    summary: legacySummary(result.summary),
  };
}

/** Soft diagnostic outcomes that still mean "the tool worked". */
function isSoftDiagnosticMiss(result) {
  return result?.errorCode === 'OPENCLAW_NOT_FOUND';
}

// ============================================================
// One-shot mode (legacy: --scan, --dry-run, --no-interactive)
// ============================================================
async function runOneShotMode() {
  if (JSON_ONLY) {
    const result = await collectDiagnostics({ quiet: true });
    if (result.error) {
      const soft = isSoftDiagnosticMiss(result);
      console.log(JSON.stringify({
        ok: soft,
        openclawFound: false,
        code: result.errorCode || (soft ? 'OPENCLAW_NOT_FOUND' : 'DIAGNOSTIC_ERROR'),
        error: result.error,
      }, null, 2));
      // Soft miss (no OpenClaw) is a completed scan, not a CLI failure.
      // Contract since 0.11.1: exit 0 + ok:true when code=OPENCLAW_NOT_FOUND.
      process.exitCode = soft ? 0 : 1;
      return;
    }
    console.log(JSON.stringify({
      ok: true,
      openclawFound: true,
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
    const soft = isSoftDiagnosticMiss(result);
    // LOCAL_ONLY covers --dry-run / -n / --no-send / --json (see options.js).
    if (LOCAL_ONLY && soft) {
      console.log(c.dim(`ℹ️  ${result.error}`));
      console.log(c.dim('Install OpenClaw: https://openclaw.ai'));
      console.log('');
      console.log(c.dim('Local scan complete — nothing was sent.'));
      process.exitCode = 0;
      return;
    }
    console.log(c.red(`❌ ${result.error}`));
    console.log('Make sure OpenClaw is installed: https://openclaw.ai');
    process.exitCode = 1;
    return;
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
  let revision = null;
  let issues = [];
  let diagnostic = null;
  let summary = null;
  let serverIssues = null; // issues returned from server after /api/diagnose
  let sendConsent = AUTO_SEND;
  let sessionQuiet = true;

  const session = createSessionController({
    runDiagnostics: async args => {
      const result = await getDiagnosticsCore().runDiagnostics(args);
      if (result.error) return result;
      return { ...result, summary: legacySummary(result.summary) };
    },
    repairEngine,
    normalizeFindings,
    knownRepairIds: Object.keys(BUILTIN_FIXES),
    makeRevisionId: randomUUID,
    onEvent: event => {
      if (!sessionQuiet && event.type.startsWith('scan.')) {
        renderScanEvent(event, (...args) => console.log(...args));
      }
    },
  });
  const offlineAnalyzer = createOfflineAnalyzer({ session });

  async function scanSession({ quiet = true } = {}) {
    sessionQuiet = quiet;
    const state = await session.scan();
    if (state.scanError) return { error: state.scanError.message };
    return state;
  }

  function syncSessionState(state) {
    revision = state.revision;
    diagnostic = state.diagnostic;
    issues = state.issues;
    summary = state.summary;
  }

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
  const scanResult = await scanSession({ quiet: true });

  if (scanResult.error) {
    console.log(c.red(`❌ ${scanResult.error}`));
    console.log('Make sure OpenClaw is installed: https://openclaw.ai');
    process.exit(1);
  }

  syncSessionState(scanResult);

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
      const result = await scanSession({ quiet: true });
      if (!result.error) {
        syncSessionState(result);

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
        const result = await scanSession({ quiet: true });
        if (!result.error) {
          syncSessionState(result);
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
        const catalogRepair = repairCatalog[issue.repairId];
        const builtinFix = BUILTIN_FIXES[issue.repairId];

        if (catalogRepair) {
          await applyCatalogRepair(issue, rl, session);
        } else if (builtinFix) {
          // Safe builtin fix — backup, apply, restart, verify
          const scanFn = async () => {
            const result = await scanSession({ quiet: true });
            if (!result.error) {
              syncSessionState(result);
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
      session.appendMessage('user', input);
      const response = await offlineAnalyzer.handle(input);
      session.appendMessage('assistant', response.message || '');
      console.log('');
      if (response.message) console.log(`  ${response.message.replaceAll('\n', '\n  ')}`);
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
 * Normalize every provenance into the stable Finding contract, then deduplicate for display only.
 * Repair authorization remains attached exclusively to explicit local/native mappings.
 */
function mergeIssues(localIssues, serverIssues) {
  return dedupeFindingsForDisplay(normalizeFindings({
    localIssues,
    serverFindings: serverIssues,
    knownRepairIds: Object.keys(BUILTIN_FIXES),
  }));
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

/**
 * Plain-text interface for one-shot and interactive modes.
 * Renders session/scan events as plain terminal text. Node 18+ compatible.
 */
export async function runPlainInterface({ mode, options, version }) {
  if (!options || typeof options !== 'object') throw new TypeError('options is required');
  if (mode !== 'one-shot' && mode !== 'interactive') {
    throw new TypeError("mode must be 'one-shot' or 'interactive'");
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('version must be a non-empty string');
  }
  configurePlainRuntime(options, { version, mode });
  // Reset diagnostics core so version/env-bound wiring matches this invocation.
  diagnosticsCore = undefined;
  if (mode === 'one-shot') {
    await runOneShotMode();
  } else {
    await runInteractiveMode();
  }
}

/** Format a session/scan event as plain log lines (no ANSI). Useful for tests and non-TTY sinks. */
export function formatSessionEvent(event) {
  if (!event || typeof event !== 'object') return '';
  switch (event.type) {
    case 'scan.started':
      return `scan started revision=${event.revision}`;
    case 'scan.step':
      return `scan step [${event.phase}] ${event.label}`;
    case 'scan.completed':
      return `scan completed revision=${event.revision} findings=${Array.isArray(event.findings) ? event.findings.length : 0}`;
    case 'scan.warning':
      return `scan warning ${event.code}: ${event.message}`;
    case 'scan.error':
      return `scan error: ${event.error?.message || 'unknown'}`;
    case 'session.scan.queued':
      return `session scan queued revision=${event.revision}`;
    case 'session.scan.committed':
      return event.error
        ? `session scan failed revision=${event.revision}: ${event.error.message}`
        : `session scan committed revision=${event.revision} findings=${event.findingsCount ?? 0}`;
    case 'session.scan.cancelled':
      return `session scan cancelled revision=${event.revision} reason=${event.reason || 'cancelled'}`;
    case 'session.scan.stale':
      return `session scan stale revision=${event.revision} reason=${event.reason || 'stale'}`;
    case 'session.message':
      return `${event.role}: ${event.text}`;
    case 'session.repair.proposed':
      return `repair proposed finding=${event.findingId} repair=${event.repairId} plan=${event.planId}`;
    default:
      return event.type ? String(event.type) : '';
  }
}

export function renderSessionEvent(event, write = (line) => console.log(line)) {
  const line = formatSessionEvent(event);
  if (line) write(line);
  return line;
}
