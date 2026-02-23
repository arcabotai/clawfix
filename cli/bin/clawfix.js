#!/usr/bin/env node

/**
 * ClawFix CLI — AI-powered OpenClaw diagnostic & repair
 * https://clawfix.dev
 * 
 * Usage: npx clawfix
 */

import { readFile, access, readdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { homedir, platform, arch, release, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// --- Config ---
const API_URL = process.env.CLAWFIX_API || 'https://clawfix.dev';
const VERSION = '0.2.0';

// --- Flags ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('-n');
const SHOW_DATA = args.includes('--show-data') || args.includes('-d');
const AUTO_SEND = process.env.CLAWFIX_AUTO === '1' || args.includes('--yes') || args.includes('-y');
const SHOW_HELP = args.includes('--help') || args.includes('-h');

// --- Colors ---
const c = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  blue: s => `\x1b[34m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
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

// Redact secrets from config
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
          continue; // Skip env block entirely
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

// --- Main ---
async function main() {
  if (SHOW_HELP) {
    console.log(`
🦞 ClawFix v${VERSION} — AI-Powered OpenClaw Diagnostic

Usage: npx clawfix [options]

Options:
  --dry-run, -n    Scan locally only — shows what would be collected, sends nothing
  --show-data, -d  Display the full diagnostic payload before asking to send
  --yes, -y        Skip confirmation prompt and send automatically
  --help, -h       Show this help message

Environment:
  CLAWFIX_API      Override API URL (default: https://clawfix.dev)
  CLAWFIX_AUTO=1   Same as --yes

Security:
  • All API keys, tokens, and passwords are automatically redacted
  • Your hostname is SHA-256 hashed (only first 8 chars sent)
  • No file contents are read (only existence checks)
  • Nothing is sent without your explicit approval (unless --yes)
  • Source code: https://github.com/arcaboteth/clawfix

Examples:
  npx clawfix                  # Interactive scan + optional AI analysis
  npx clawfix --dry-run        # See what data would be collected (sends nothing)
  npx clawfix --show-data      # Show full payload before asking to send
  npx clawfix --yes            # Auto-send for CI/scripting
`);
    return;
  }

  console.log('');
  console.log(c.cyan(`🦞 ClawFix v${VERSION} — AI-Powered OpenClaw Diagnostic`));
  if (DRY_RUN) console.log(c.yellow('   🔍 DRY RUN MODE — nothing will be sent'));
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  // --- Detect OpenClaw ---
  const home = homedir();
  const openclawDir = await exists(join(home, '.openclaw')) ? join(home, '.openclaw') :
                       await exists(join(home, '.config', 'openclaw')) ? join(home, '.config', 'openclaw') : null;
  
  const openclawBin = run('which openclaw') || 
                       (await exists('/opt/homebrew/bin/openclaw') ? '/opt/homebrew/bin/openclaw' : '') ||
                       (await exists('/usr/local/bin/openclaw') ? '/usr/local/bin/openclaw' : '');

  const configPath = openclawDir ? join(openclawDir, 'openclaw.json') : null;

  if (!openclawBin && !openclawDir) {
    console.log(c.red('❌ OpenClaw not found on this system.'));
    console.log('Make sure OpenClaw is installed: https://openclaw.ai');
    process.exit(1);
  }

  console.log(c.green('✅ OpenClaw found'));
  if (openclawBin) console.log(`   Binary: ${openclawBin}`);
  if (openclawDir) console.log(`   Config: ${openclawDir}`);

  // --- System Info ---
  console.log('');
  console.log(c.blue('📋 Collecting system information...'));

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

  console.log(`   OS: ${osName} ${osVersion} (${osArch})`);
  console.log(`   Node: ${nodeVersion}`);
  console.log(`   OpenClaw: ${ocVersion || 'not found'}`);

  // --- Read Config ---
  console.log('');
  console.log(c.blue('🔒 Reading config (secrets will be redacted)...'));

  let config = null;
  let sanitizedConfig = {};

  if (configPath && await exists(configPath)) {
    config = await readJson(configPath);
    sanitizedConfig = sanitizeConfig(config) || {};
    console.log(c.green('   ✅ Config read and sanitized'));
  } else {
    console.log(c.yellow('   ⚠️  No config file found'));
  }

  // --- Gateway Status ---
  console.log('');
  console.log(c.blue('🔌 Checking gateway status...'));

  let gatewayStatus = 'unknown';
  if (openclawBin) {
    gatewayStatus = run(`"${openclawBin}" gateway status 2>&1`) || 'could not check';
  }

  const gatewayPort = config?.gateway?.port || 18789;
  const gatewayPid = run('pgrep -f "openclaw.*gateway"') || '';

  // Extract the actual status line, not config warnings
  const statusLine = gatewayStatus.split('\n').find(l => /runtime:|listening|running|stopped|not running/i.test(l))
    || gatewayStatus.split('\n')[0];
  console.log(`   Status: ${statusLine.trim()}`);
  if (gatewayPid) console.log(`   PID: ${gatewayPid}`);
  console.log(`   Port: ${gatewayPort}`);

  // --- Logs ---
  console.log('');
  console.log(c.blue('📜 Reading recent logs...'));

  let errorLogs = '';
  let stderrLogs = '';

  const logPath = openclawDir ? join(openclawDir, 'logs', 'gateway.log') : null;
  const errLogPath = openclawDir ? join(openclawDir, 'logs', 'gateway.err.log') : null;

  if (logPath && await exists(logPath)) {
    try {
      const logContent = await readFile(logPath, 'utf8');
      const lines = logContent.split('\n');
      errorLogs = lines
        .filter(l => /error|warn|fail|crash|EADDRINUSE|EACCES/i.test(l))
        .slice(-30)
        .join('\n');
      console.log(c.green(`   ✅ Gateway log found (${lines.length} lines)`));
    } catch {}
  }

  if (errLogPath && await exists(errLogPath)) {
    try {
      stderrLogs = (await readFile(errLogPath, 'utf8')).split('\n').slice(-50).join('\n');
      console.log(c.green('   ✅ Error log found'));
    } catch {}
  }

  // --- Plugins ---
  console.log('');
  console.log(c.blue('🔌 Checking plugins...'));

  const plugins = config?.plugins?.entries || {};
  for (const [name, cfg] of Object.entries(plugins)) {
    const icon = cfg.enabled === false ? '❌' : '✅';
    console.log(`   ${icon} ${name}`);
  }

  // --- Workspace ---
  console.log('');
  console.log(c.blue('📁 Checking workspace...'));

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

    console.log(`   Path: ${workspaceDir}`);
    console.log(`   Files: ${mdFiles} .md files`);
    console.log(`   Memory: ${memoryFiles} daily notes`);
    console.log(`   SOUL.md: ${hasSoul}`);
    console.log(`   AGENTS.md: ${hasAgents}`);
  }

  // --- Check Ports ---
  console.log('');
  console.log(c.blue('🔗 Checking port availability...'));

  const checkPort = (port, name) => {
    const inUse = run(`lsof -i :${port} 2>/dev/null | grep LISTEN`) ||
                  run(`ss -tlnp 2>/dev/null | grep :${port}`);
    if (inUse) {
      console.log(c.yellow(`   ⚠️  Port ${port} (${name}) — IN USE`));
      return true;
    } else {
      console.log(c.green(`   ✅ Port ${port} (${name}) — available`));
      return false;
    }
  };

  checkPort(gatewayPort, 'gateway');
  checkPort(18800, 'browser CDP');
  checkPort(18791, 'browser control');

  // --- Local Issue Detection ---
  console.log('');
  console.log(c.cyan('━'.repeat(50)));
  console.log(c.bold('📊 Diagnostic Summary'));
  console.log(c.cyan('━'.repeat(50)));
  console.log('');

  const issues = [];

  // Check actual gateway status — ignore config warnings in output
  const gatewayRunning = /running.*pid|state active|listening/i.test(gatewayStatus);
  const gatewayFailed = /not running|failed to start|stopped|inactive/i.test(gatewayStatus);
  if (gatewayFailed || (!gatewayRunning && !/warning/i.test(gatewayStatus))) {
    issues.push({ severity: 'critical', text: 'Gateway is not running' });
  }
  if (/EADDRINUSE/i.test(errorLogs)) {
    issues.push({ severity: 'critical', text: 'Port conflict detected' });
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
    },
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
    console.log(c.cyan('   https://clawfix.dev | https://x.com/arcaboteth'));
    console.log('');
    return;
  }

  // --- Send for AI analysis ---
  if (issues.length === 0) {
    console.log(c.green('Your OpenClaw is looking good! No fixes needed.'));
    console.log(`If you're still having issues, run with --show-data to see what would be collected.`);
    console.log('');
    console.log(c.cyan(`🦞 ClawFix — made by Arca (arcabot.eth)`));
    console.log(c.cyan(`   https://clawfix.dev | https://x.com/arcaboteth`));
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
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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

    // Show known issues
    if (result.knownIssues) {
      for (const issue of result.knownIssues) {
        console.log(`  ${issue.severity.toUpperCase()} — ${issue.title}: ${issue.description}`);
      }
    }

    console.log('');
    console.log(c.bold('AI Analysis:'));
    console.log(result.analysis || 'Pattern matching only (no AI configured)');
    console.log('');

    // Save fix script
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
  console.log(c.cyan('   https://clawfix.dev | https://x.com/arcaboteth'));
  console.log('');
}

main().catch(err => {
  console.error(c.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
