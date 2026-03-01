#!/usr/bin/env node

/**
 * ClawFix CLI — AI-powered OpenClaw diagnostic and repair
 * 
 * Usage: npx clawfix
 *        npx clawfix --json     (machine-readable output)
 *        npx clawfix --no-send  (scan only, don't send to API)
 *        npx clawfix --server URL (custom API server)
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const VERSION = '0.5.0';
const DEFAULT_API = 'https://clawfix.dev';
const ARGS = process.argv.slice(2);
const JSON_MODE = ARGS.includes('--json');
const NO_SEND = ARGS.includes('--no-send') || ARGS.includes('--dry-run');
const API_URL = ARGS.find(a => a.startsWith('--server='))?.split('=')[1] 
  || ARGS[ARGS.indexOf('--server') + 1] 
  || DEFAULT_API;

if (ARGS.includes('--help') || ARGS.includes('-h')) {
  console.log(`
🦞 ClawFix v${VERSION} — AI-powered OpenClaw diagnostic and repair

Usage:
  npx clawfix              Run diagnostic and get AI fix
  npx clawfix --json       Machine-readable JSON output
  npx clawfix --no-send    Scan only (don't send to API)
  npx clawfix --dry-run    Same as --no-send (inspect data only)
  npx clawfix --server URL Use custom API server

Options:
  -h, --help     Show this help
  -v, --version  Show version

Website: https://clawfix.dev
Source:  https://github.com/arcabotai/clawfix
`);
  process.exit(0);
}

if (ARGS.includes('--version') || ARGS.includes('-v')) {
  console.log(`clawfix v${VERSION}`);
  process.exit(0);
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
};

function log(msg = '') { if (!JSON_MODE) console.log(msg); }
function logErr(msg) { console.error(JSON_MODE ? JSON.stringify({ error: msg }) : c.red(`❌ ${msg}`)); }

// --- Helpers ---
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return ''; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function hashHostname() {
  const hostname = run('hostname') || 'unknown';
  // Simple hash — not crypto, just privacy
  let h = 0;
  for (let i = 0; i < hostname.length; i++) h = ((h << 5) - h + hostname.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 8);
}

// --- Sanitize config (redact secrets) ---
function sanitizeConfig(config) {
  if (!config) return {};
  const str = JSON.stringify(config);
  // Redact anything that looks like a secret
  const redacted = str.replace(
    /("(?:key|token|secret|password|jwt|apiKey|accessToken|apikey|bearer)":\s*")([^"]{8,})(")/gi,
    '$1***REDACTED***$3'
  );
  const parsed = JSON.parse(redacted);
  // Remove env block entirely
  delete parsed.env;
  // Redact known sensitive paths
  if (parsed.gateway?.auth?.token) parsed.gateway.auth.token = '***REDACTED***';
  if (parsed.channels) {
    for (const [, ch] of Object.entries(parsed.channels)) {
      if (ch.accessToken) ch.accessToken = '***REDACTED***';
      if (ch.apiKey) ch.apiKey = '***REDACTED***';
      if (ch.token) ch.token = '***REDACTED***';
    }
  }
  return parsed;
}

// --- Main ---
async function main() {
  log(c.cyan(`\n🦞 ClawFix v${VERSION} — AI-Powered OpenClaw Diagnostic`));
  log(c.cyan('━'.repeat(52)));
  log();

  // 1. Find OpenClaw
  const ocBin = run('which openclaw') || 
    (existsSync('/opt/homebrew/bin/openclaw') ? '/opt/homebrew/bin/openclaw' : '') ||
    (existsSync('/usr/local/bin/openclaw') ? '/usr/local/bin/openclaw' : '');
  
  const ocDir = existsSync(join(homedir(), '.openclaw')) ? join(homedir(), '.openclaw') :
    existsSync(join(homedir(), '.config/openclaw')) ? join(homedir(), '.config/openclaw') : '';
  
  const configPath = ocDir ? join(ocDir, 'openclaw.json') : '';

  if (!ocBin && !ocDir) {
    logErr('OpenClaw not found on this system.');
    process.exit(1);
  }

  log(c.green('✅ OpenClaw found'));
  if (ocBin) log(`   Binary: ${ocBin}`);
  if (ocDir) log(`   Config: ${ocDir}`);

  // 2. System info
  log();
  log(c.blue('📋 Collecting system information...'));
  const system = {
    os: run('uname -s'),
    osVersion: run('uname -r'),
    arch: run('uname -m'),
    nodeVersion: run('node --version'),
    npmVersion: run('npm --version'),
  };
  const ocVersion = ocBin ? run(`${ocBin} --version`) : 'unknown';
  log(`   OS: ${system.os} ${system.osVersion} (${system.arch})`);
  log(`   Node: ${system.nodeVersion}`);
  log(`   OpenClaw: ${ocVersion}`);

  // 3. Read config
  log();
  log(c.blue('🔒 Reading config (secrets redacted)...'));
  const rawConfig = configPath ? readJson(configPath) : null;
  const config = sanitizeConfig(rawConfig);
  log(rawConfig ? c.green('   ✅ Config read and sanitized') : c.yellow('   ⚠️  No config file found'));

  // 4. Gateway status
  log();
  log(c.blue('🔌 Checking gateway status...'));
  const gatewayStatus = ocBin ? run(`${ocBin} gateway status 2>&1`) : 'unknown';
  const gatewayPid = run('pgrep -f "openclaw.*gateway" 2>/dev/null | head -1');
  const gatewayPort = rawConfig?.gateway?.port || '18789';
  // Check if port is actually listening (zombie detection)
  const portListening = !!run(`lsof -i :${gatewayPort} 2>/dev/null | head -1`) ||
    !!run(`ss -tlnp 2>/dev/null | grep ":${gatewayPort} "`);
  const processExists = !!gatewayPid;

  log(`   Status: ${gatewayStatus.split('\n')[0]}`);
  if (gatewayPid) log(`   PID: ${gatewayPid} (exists: ${processExists})`);
  log(`   Port: ${gatewayPort} (listening: ${portListening})`);
  if (processExists && !portListening) {
    log(c.red(`   ⚠️  Zombie gateway: process exists but port not listening`));
  }

  // 5. Service manager detection
  log();
  log(c.blue('🔧 Checking service manager...'));
  const osName = system.os;
  let serviceManager = 'none';
  let serviceState = '';
  let serviceExitCode = '';

  if (osName === 'Darwin') {
    serviceManager = 'launchd';
    const launchctlOut = run('launchctl list 2>/dev/null | grep -i openclaw');
    if (launchctlOut) {
      const parts = launchctlOut.split(/\s+/);
      const svcPid = parts[0];
      serviceExitCode = parts[1] || '';
      if (serviceExitCode === '-15') {
        serviceState = 'sigterm';
        log(c.red('   ⚠️  Service received SIGTERM (exit -15) — possible crash loop'));
      } else if (serviceExitCode === '0' && svcPid !== '-') {
        serviceState = 'running';
        log(c.green(`   ✅ launchd: running (pid ${svcPid})`));
      } else if (svcPid === '-' && serviceExitCode !== '0') {
        serviceState = 'crashed';
        log(c.red(`   ❌ launchd: not running (last exit: ${serviceExitCode})`));
      } else {
        serviceState = 'unknown';
        log(c.yellow(`   ⚠️  launchd state unclear: ${launchctlOut}`));
      }
    } else {
      serviceState = 'not_registered';
      log(c.yellow('   ⚠️  No openclaw LaunchAgent found in launchctl'));
    }
  } else if (run('command -v systemctl')) {
    serviceManager = 'systemd';
    const systemctlOut = run('systemctl status openclaw-gateway 2>/dev/null | head -10');
    if (systemctlOut.includes('active (running)')) {
      serviceState = 'running';
      log(c.green('   ✅ systemd: active (running)'));
    } else if (systemctlOut.includes('failed')) {
      serviceState = 'failed';
      log(c.red('   ❌ systemd: failed'));
    } else if (systemctlOut.includes('inactive')) {
      serviceState = 'inactive';
      log(c.yellow('   ⚠️  systemd: inactive (stopped)'));
    }
  } else {
    log('   No service manager detected');
  }

  log();
  log(c.blue('📜 Reading recent logs...'));
  const logDir = ocDir ? join(ocDir, 'logs') : '';
  let errorLogs = '';
  let stderrLogs = '';
  let errLogSizeMB = 0;
  let handshakeTimeoutCount = 0;
  let sigtermCount = 0;

  if (logDir && existsSync(join(logDir, 'gateway.log'))) {
    errorLogs = run(`grep -i "error\\|warn\\|fail\\|crash\\|EADDRINUSE" ${join(logDir, 'gateway.log')} | tail -30`);
    sigtermCount = parseInt(run(`grep -c "signal SIGTERM received\\|exit code -15" ${join(logDir, 'gateway.log')} 2>/dev/null`)) || 0;
    log(c.green('   ✅ Gateway log found'));
    if (sigtermCount > 0) log(c.yellow(`   ⚠️  ${sigtermCount} SIGTERM events in gateway log`));
  }
  if (logDir && existsSync(join(logDir, 'gateway.err.log'))) {
    stderrLogs = run(`tail -50 ${join(logDir, 'gateway.err.log')}`);
    errLogSizeMB = parseInt(run(`du -sm ${join(logDir, 'gateway.err.log')} 2>/dev/null | awk '{print $1}'`)) || 0;
    handshakeTimeoutCount = parseInt(run(`grep -c "invalid handshake\\|closed before connect\\|chrome-extension.*timeout" ${join(logDir, 'gateway.err.log')} 2>/dev/null`)) || 0;
    if (errLogSizeMB > 10) {
      log(c.yellow(`   ⚠️  Error log is ${errLogSizeMB}MB (large — likely log spam)`));
    } else {
      log(c.green(`   ✅ Error log found (${errLogSizeMB}MB)`));
    }
    if (handshakeTimeoutCount > 0) log(c.yellow(`   ⚠️  ${handshakeTimeoutCount} handshake timeout lines`));
  }

  // 7. Plugins
  log();
  log(c.blue('🔌 Checking plugins...'));
  const plugins = rawConfig?.plugins?.entries || {};
  for (const [name, plugin] of Object.entries(plugins)) {
    const enabled = plugin.enabled !== false;
    log(`   ${enabled ? '✅' : '❌'} ${name}`);
  }

  // 8. Workspace
  log();
  log(c.blue('📁 Checking workspace...'));
  const workspacePath = rawConfig?.agents?.defaults?.workspace || '';
  let mdFiles = 0, memoryFiles = 0, hasSoul = false, hasAgents = false;
  if (workspacePath && existsSync(workspacePath)) {
    try {
      mdFiles = parseInt(run(`find "${workspacePath}" -name "*.md" 2>/dev/null | wc -l`)) || 0;
      const memDir = join(workspacePath, 'memory');
      if (existsSync(memDir)) {
        memoryFiles = readdirSync(memDir).filter(f => f.endsWith('.md')).length;
      }
      hasSoul = existsSync(join(workspacePath, 'SOUL.md'));
      hasAgents = existsSync(join(workspacePath, 'AGENTS.md'));
    } catch {}
    log(`   Path: ${workspacePath}`);
    log(`   Files: ${mdFiles} .md files, ${memoryFiles} memory notes`);
    log(`   SOUL.md: ${hasSoul}, AGENTS.md: ${hasAgents}`);
  }

  // 9. Ports
  log();
  log(c.blue('🔗 Checking ports...'));
  for (const [port, name] of [[gatewayPort, 'gateway'], ['18791', 'browser control'], ['18792', 'extension relay'], ['18800', 'browser CDP']]) {
    const inUse = run(`lsof -i :${port} 2>/dev/null | head -1`);
    log(`   ${inUse ? c.yellow(`⚠️  Port ${port} (${name}) — IN USE`) : c.green(`✅ Port ${port} (${name}) — available`)}`);
  }

  // 10. Browser & Extension Relay
  log();
  log(c.blue('🌐 Checking browser relay...'));
  const browserDir = ocDir ? join(ocDir, 'browser') : '';
  const browserStatus = browserDir && existsSync(browserDir) ? 'configured' : 'not configured';
  const relayPort = '18792';
  const relayPortListening = !!run(`lsof -i :${relayPort} 2>/dev/null | head -1`) ||
    !!run(`ss -tlnp 2>/dev/null | grep ":${relayPort} "`);
  
  // Check extension installation
  const extensionDir = ocDir ? join(ocDir, 'browser', 'chrome-extension') : '';
  const extensionInstalled = extensionDir && existsSync(extensionDir) && existsSync(join(extensionDir, 'background.js'));
  const hasOptionsValidation = extensionDir && existsSync(join(extensionDir, 'options-validation.js'));
  const hasDeriveRelayToken = extensionDir && existsSync(join(extensionDir, 'background-utils.js'))
    ? run(`grep -c "deriveRelayToken" "${join(extensionDir, 'background-utils.js')}" 2>/dev/null`) !== '0'
    : false;

  // Check for wrong-port indicators in logs
  const wrongPortHits = parseInt(run(`grep -c "host=127.0.0.1:18789.*chrome-extension\\|chrome-extension.*:18789" ${join(logDir, 'gateway.err.log')} 2>/dev/null`)) || 0;

  if (relayPortListening) {
    log(c.green(`   ✅ Relay port ${relayPort} — listening`));
  } else {
    log(c.yellow(`   ⚠️  Relay port ${relayPort} — not listening`));
  }
  if (extensionInstalled) {
    log(`   Extension: installed`);
    if (!hasOptionsValidation) log(c.yellow('   ⚠️  Missing options-validation.js (outdated extension)'));
    if (!hasDeriveRelayToken) log(c.yellow('   ⚠️  Missing deriveRelayToken (outdated auth method)'));
  } else {
    log(c.dim('   Extension: not installed'));
  }
  if (wrongPortHits > 0) {
    log(c.red(`   ⚠️  ${wrongPortHits} wrong-port connections detected (extension → port 18789)`));
  }

  // Build diagnostic payload
  const diagnostic = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    hostHash: hashHostname(),
    system,
    openclaw: {
      version: ocVersion,
      binary: ocBin || 'not found',
      configDir: ocDir || 'not found',
      gatewayStatus,
      gatewayPid: gatewayPid || 'none',
      gatewayPort,
      processExists,
      portListening,
    },
    service: {
      manager: serviceManager,
      state: serviceState || 'unknown',
      exitCode: serviceExitCode,
    },
    config,
    logs: {
      errors: errorLogs,
      stderr: stderrLogs,
      errLogSizeMB,
      handshakeTimeoutCount,
      sigtermCount,
    },
    workspace: {
      path: workspacePath || 'unknown',
      mdFiles, memoryFiles,
      hasSoul, hasAgents,
    },
    browser: {
      status: browserStatus,
      relayPort,
      relayPortListening,
      extensionInstalled,
      extension: {
        missingOptionsValidation: extensionInstalled && !hasOptionsValidation,
        hasDeriveRelayToken: extensionInstalled ? hasDeriveRelayToken : undefined,
      },
      wrongPortHits,
    },
  };

  // JSON mode — just output and exit
  if (JSON_MODE && NO_SEND) {
    console.log(JSON.stringify(diagnostic, null, 2));
    process.exit(0);
  }

  // No-send mode — show summary
  if (NO_SEND) {
    log();
    log(c.cyan('━'.repeat(52)));
    log(c.bold('📊 Diagnostic collected (not sent)'));
    log(`   Use --json to see the full payload`);
    log(`   Remove --no-send to get AI analysis`);
    process.exit(0);
  }

  // 11. Send to API
  log();
  log(c.cyan('━'.repeat(52)));
  log(c.bold('📡 Sending diagnostic for AI analysis...'));
  log(c.dim(`   → ${API_URL}/api/diagnose`));
  log();

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

    if (JSON_MODE) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    // Display results
    log(c.green(`✅ Diagnosis complete! Found ${result.issuesFound} issue(s).`));
    log();

    // Known issues
    if (result.knownIssues?.length) {
      for (const issue of result.knownIssues) {
        const sevColor = { critical: c.red, high: c.red, medium: c.yellow, low: c.blue }[issue.severity] || c.dim;
        log(`  ${sevColor(issue.severity.toUpperCase())} — ${c.bold(issue.title)}`);
        log(c.dim(`    ${issue.description}`));
        log();
      }
    }

    // AI analysis
    if (result.analysis) {
      log(c.bold('🧠 AI Analysis:'));
      log(result.analysis);
      log();
    }

    // Fix script
    if (result.fixScript) {
      const fixPath = `/tmp/clawfix-${result.fixId}.sh`;
      const { writeFileSync } = await import('fs');
      writeFileSync(fixPath, result.fixScript);

      log(c.cyan('━'.repeat(52)));
      log();
      log(c.bold(`📋 Fix script saved to: ${fixPath}`));
      log(`   Review it:  ${c.cyan(`cat ${fixPath}`)}`);
      log(`   Apply it:   ${c.cyan(`bash ${fixPath}`)}`);
      log();
      log(c.bold('🌐 View results in browser:'));
      log(`   ${c.cyan(`${API_URL}/results/${result.fixId}`)}`);
      log();
      log(`${c.bold('Fix ID:')} ${result.fixId}`);
    }

    log();
    log(c.cyan('🦞 ClawFix — made by Arca (arcabot.eth)'));
    log(c.cyan(`   ${API_URL} | https://x.com/arcabotai`));
    log();

  } catch (err) {
    logErr(`API error: ${err.message}`);
    log();
    log('You can still view the diagnostic data:');
    log(`  npx clawfix --no-send --json`);
    process.exit(1);
  }
}

main().catch(err => {
  logErr(err.message);
  process.exit(1);
});
