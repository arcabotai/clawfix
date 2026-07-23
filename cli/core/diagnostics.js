import { join } from 'node:path';

import {
  scanCompleted, scanError, scanStarted, scanStep,
} from './events.js';

// ClawFix Task 4 extracts collectDiagnostics() (cli/bin/clawfix.js) into this console-free,
// transport-neutral, cancellable core in small vertical RED-GREEN slices. This module currently
// implements the discover, system, config, gateway, logs, service, workspace, ports, and native
// collection bands, pure issue derivation, and envelope/semantic-summary assembly (Slices 2-5).
// Cancellation/deadline machinery lands in a later slice (6), and the cli/bin/clawfix.js
// shim/renderer swap-in lands in Slice 7. Nothing in cli/bin/clawfix.js imports this module yet,
// so its incompleteness does not affect the running CLI.
export class DiagnosticsCoreIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiagnosticsCoreIncompleteError';
    this.code = 'NOT_IMPLEMENTED';
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireBoundary(value, name, methods) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function`);
    }
  }
  return value;
}

function validateRevision(revision) {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new TypeError('revision must be a non-empty string');
  }
  return revision;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Best-effort extraction of a non-empty string message from whatever an injected boundary threw
// (which may not be a real Error). scanError() requires a non-empty error.message, so this
// guarantees the terminal-event construction itself never fails.
function toSafeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return typeof message === 'string' && message.length > 0 ? message : 'Unknown internal error';
}

// deriveIssues() is the verbatim-behavior port of the original collectDiagnostics() "Local Issue
// Detection" block (cli/bin/clawfix.js lines ~860-1098). It is a pure function: every fact it
// reasons about (config, per-band collection results) is read from the `collected` argument, and
// it performs no filesystem/process/console/clock/network access and touches no ambient global.
// It also never mutates its input — every pushed issue is a freshly-constructed object, and the
// trailing `kind` defaulting loop below mutates only those freshly-constructed local objects, not
// anything reachable from `collected`.
export function deriveIssues(collected) {
  const {
    config,
    system,
    gateway,
    logs,
    serviceHealth,
    workspace,
    ports,
    nativeDoctor,
    nativeConfig,
    nativeStatus,
    nativeSecurity,
  } = collected;

  const issues = [];

  const gatewayPortFinding = ports.gateway?.finding;
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
    ...(Array.isArray(config?.agents?.list) ? config.agents.list.map((agent) => agent?.agentRuntime) : []),
  ].filter(Boolean);
  const hasPiFallback = agentRuntimes.some((runtime) => (
    runtime === 'pi'
    || runtime?.id === 'pi'
    || runtime?.fallback === 'pi'
  ));
  const hasNativeCodexRuntime = agentRuntimes.some((runtime) => (
    runtime === 'codex'
    || runtime?.id === 'codex'
  ));
  const codexPlugin = config?.plugins?.entries?.codex || null;
  const codexPluginEnabled = !!codexPlugin && codexPlugin.enabled !== false;
  const codexAppServer = codexPlugin?.config?.appServer || {};
  const shellCodexHomeMatchesExpected = workspace?.codexHome?.matchesExpected === true;
  const combinedLogs = [logs.errorLogs, logs.stderrLogs, logs.gatewayLogTail, gateway.gatewayStatus]
    .filter(Boolean).join('\n');

  const { gatewayStatus } = gateway;
  const gatewayRunning = /running.*pid|state active|listening/i.test(gatewayStatus);
  const gatewayFailed = /not running|failed to start|stopped|inactive/i.test(gatewayStatus);
  const listenerPid = Number(ports.gateway?.pid);
  const expectedGatewayPid = Number.parseInt(String(gateway.gatewayPid || ''), 10);
  const competingPortOwner = ports.gateway?.listening === true
    && Number.isSafeInteger(listenerPid) && listenerPid > 0 && (
      (Number.isSafeInteger(expectedGatewayPid) && expectedGatewayPid > 0 && listenerPid !== expectedGatewayPid)
      || !gateway.gatewayPid
    );
  if ((gatewayFailed || (!gatewayRunning && !/warning/i.test(gatewayStatus))) && !competingPortOwner) {
    issues.push({ severity: 'critical', text: 'Gateway is not running' });
  }
  if (competingPortOwner) {
    issues.push({ severity: 'critical', text: 'Port conflict detected' });
  }
  if (system.runtimeCompatible === false && system.runtimeRequired) {
    issues.push({
      severity: 'critical',
      text: `OpenClaw requires Node ${system.runtimeRequired} (current: ${system.runtimeCurrent || system.nodeVersion})`,
      source: 'openclaw-runtime',
    });
  }
  if ((config?.plugins?.load?.paths || []).some((path) => (
    typeof path === 'string' && /openclaw\/dist\/extensions\//.test(path)
  )) || /ignored plugins\.load\.paths entry.*bundled plugin directory/i.test(combinedLogs)) {
    issues.push({ severity: 'medium', text: 'Stale bundled plugin load paths configured' });
  }
  if (codexPluginEnabled && (activeModelRefs.some((ref) => String(ref).startsWith('openai-codex/')) || hasPiFallback)) {
    issues.push({ knownIssueId: 'pi-backed-openai-codex-route', severity: 'high', text: 'PI-backed openai-codex route active instead of native Codex harness' });
  }
  if (/Codex cannot access session files.*\.codex[\/\\]sessions|Operation not permitted.*\.codex[\/\\]sessions|permission denied.*\.codex[\/\\]sessions/i.test(combinedLogs)) {
    issues.push({ knownIssueId: 'codex-session-store-permission', severity: 'high', text: 'Codex session-store permission failure' });
  }
  if (codexPluginEnabled && hasNativeCodexRuntime && !shellCodexHomeMatchesExpected) {
    issues.push({ knownIssueId: 'codex-shell-home-mismatch', severity: 'medium', text: 'Shell CODEX_HOME does not match OpenClaw Codex home' });
  }
  if (codexPluginEnabled
      && (hasNativeCodexRuntime || activeModelRefs.some((ref) => String(ref).startsWith('openai/')))
      && codexAppServer.serviceTier !== 'fast') {
    issues.push({ knownIssueId: 'codex-service-tier-not-fast', severity: 'low', kind: 'optimization', text: 'Codex app-server fast tier is not enabled' });
  }
  const codexRequestTimeoutMs = Number(codexAppServer.requestTimeoutMs ?? 60000);
  const activeMemoryTimeoutMs = Number(config?.plugins?.entries?.['active-memory']?.config?.timeoutMs ?? NaN);
  const codexTimeoutSymptoms = (
    /EMBEDDED FALLBACK: Gateway agent failed|gateway closed \((1006|1012)\)|codex app-server startup aborted/i.test(combinedLogs)
    || /active-memory:.*status=timeout|lane=.*active-memory.*durationMs=\d+.*codex app-server startup aborted/i.test(combinedLogs)
  );
  if (codexPluginEnabled && hasNativeCodexRuntime && codexTimeoutSymptoms
      && (codexRequestTimeoutMs <= 60000 || activeMemoryTimeoutMs <= 60000)) {
    issues.push({ knownIssueId: 'native-codex-timeout-boundary', severity: 'high', text: 'Native Codex timeout boundary can force gateway fallback' });
  }

  const sigtermCount = (logs.gatewayLogTail.match(/signal SIGTERM/gi) || []).length;
  const restartCount = (logs.gatewayLogTail.match(/listening.*PID/gi) || []).length;
  if (config?.update?.auto?.enabled === true && (sigtermCount >= 2 || restartCount >= 3)) {
    issues.push({ severity: 'critical', text: 'Auto-update causing gateway restart loop' });
  } else if (config?.update?.auto?.enabled === true) {
    issues.push({ severity: 'medium', text: 'Auto-update enabled (risk of restart loops)' });
  }

  const reloadCount = (logs.gatewayLogTail.match(/config change detected.*evaluating reload/gi) || []).length;
  if (reloadCount >= 3) {
    issues.push({ severity: 'high', text: `Config reload cascade detected (${reloadCount} reloads in recent logs)` });
  }

  if (serviceHealth.runs > 2 && (serviceHealth.uptimeSeconds || 0) < 300) {
    issues.push({ severity: 'critical', text: `Gateway crash loop — ${serviceHealth.runs} restarts, only ${serviceHealth.uptimeStr} uptime` });
  } else if ((serviceHealth.nRestarts || 0) > 0) {
    issues.push({ severity: 'high', text: `Gateway has restarted ${serviceHealth.nRestarts} time(s) (systemd)` });
  }

  const handshakeSpam = (logs.stderrLogs.match(/invalid handshake.*chrome-extension|closed before connect.*chrome-extension/gi) || []).length;
  if (handshakeSpam >= 5) {
    issues.push({ severity: 'medium', text: 'Browser Relay extension spamming invalid handshakes' });
  }

  if (logs.errLogSizeMB > 50) {
    issues.push({ severity: 'medium', text: `Error log is ${logs.errLogSizeMB}MB (should be <50MB)` });
  }

  const matrixTimeouts = (logs.stderrLogs.match(/ESOCKETTIMEDOUT/gi) || []).length;
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
  if (!workspace.hasSoul && workspace.workspaceDir) {
    issues.push({ severity: 'low', kind: 'optimization', text: 'No SOUL.md found (agent has no personality)' });
  }
  if (workspace.memoryFiles === 0 && workspace.workspaceDir) {
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
    nativeStatus.available
    && nativeStatus.gateway.reachable === false
    && !issues.some((issue) => /gateway.*not running|gateway.*unreachable/i.test(issue.text))
  ) {
    issues.push({
      severity: 'critical',
      text: nativeStatus.gateway.error || 'OpenClaw gateway is unreachable',
      source: 'openclaw-status',
      nativeCheckId: 'status/gateway-unreachable',
    });
  }

  if (
    competingPortOwner
    && nativeStatus.available
    && nativeStatus.gateway.reachable === false
  ) {
    const owner = ports.gateway.process;
    const { pid } = ports.gateway;
    issues.push({
      severity: 'critical',
      text: `Gateway port ${gateway.gatewayPort} is occupied${owner ? ` by ${owner}` : ''}${pid ? ` (PID ${pid})` : ''}, but OpenClaw cannot reach it`,
      source: 'clawfix-port-probe',
      nativeCheckId: 'runtime/gateway-port-conflict',
    });
  }

  for (const finding of nativeSecurity.findings) {
    if (finding.severity === 'info') continue;
    issues.push({
      severity: finding.severity === 'critical' ? 'critical'
        : finding.severity === 'error' ? 'high' : 'medium',
      text: finding.title || finding.message,
      description: finding.message,
      source: finding.source,
      nativeCheckId: finding.checkId,
      path: finding.path,
      fixHint: finding.fixHint,
    });
  }

  for (const finding of nativeDoctor.findings) {
    const duplicate = issues.some((issue) => (
      issue.nativeCheckId === finding.checkId
      || issue.text.toLowerCase() === finding.message.toLowerCase()
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

  return issues;
}

// createDiagnosticsCore takes every ambient boundary the original collectDiagnostics() reached
// for directly (filesystem, OpenClaw, OS facts, environment, clock, hashing, native probes, and
// redaction) as a required injected dependency, so the core itself performs no ambient global
// reads. `redact` has no default: a missing redactor must fail loudly at construction rather than
// silently leak secrets, and injecting it here (rather than importing cli/bin/security.js
// directly) keeps cli/core/ from depending on cli/bin/ — the real redactOutbound is wired in by
// the cli/bin/clawfix.js entrypoint in a later slice.
export function createDiagnosticsCore({
  version,
  redact,
  fs,
  openclaw,
  os,
  env,
  clock,
  createHash,
  nativeCollectors,
} = {}) {
  requireNonEmptyString(version, 'version');
  requireFunction(redact, 'redact');
  requireBoundary(fs, 'fs', ['exists', 'readJson', 'stat', 'readdir', 'countMarkdownFiles']);
  requireBoundary(openclaw, 'openclaw', [
    'findExecutable', 'npmVersion', 'version',
    'gatewayStatusText', 'gatewayProcesses', 'readFileTail', 'serviceManagerState',
  ]);
  requireBoundary(os, 'os', ['homedir', 'platform', 'release', 'arch', 'hostname', 'nodeVersion']);
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }
  requireBoundary(clock, 'clock', ['now']);
  requireFunction(createHash, 'createHash');
  requireBoundary(nativeCollectors, 'nativeCollectors', [
    'collectOpenClawVersion',
    'collectListeningPort',
    'collectNativeDoctor',
    'collectNativeConfigValidation',
    'collectNativeStatus',
    'collectNativeSecurityAudit',
  ]);

  async function discover() {
    const home = os.homedir();
    const openclawDir = await fs.exists(join(home, '.openclaw'))
      ? join(home, '.openclaw')
      : await fs.exists(join(home, '.config', 'openclaw'))
        ? join(home, '.config', 'openclaw')
        : null;
    const openclawBin = (await openclaw.findExecutable()) || '';
    return { home, openclawDir, openclawBin };
  }

  async function collectSystem(openclawBin) {
    const osName = os.platform();
    const osVersion = os.release();
    const osArch = os.arch();
    const nodeVersion = os.nodeVersion();
    const npmVersion = await openclaw.npmVersion({ timeoutMs: 5000 });
    const hostHash = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);

    const versionResult = openclawBin
      ? await openclaw.version({
        executable: openclawBin,
        timeoutMs: 10_000,
        maxStdoutBytes: 1_200,
        maxStderrBytes: 4_000,
      })
      : null;
    const versionProbe = versionResult
      ? nativeCollectors.collectOpenClawVersion(openclawBin, () => versionResult)
      : { version: '', runtimeCompatible: false, error: 'OpenClaw binary not found' };

    return {
      osName,
      osVersion,
      osArch,
      nodeVersion,
      npmVersion,
      hostHash,
      ocVersion: versionProbe.version,
      // Retained (not emitted in the system scan.step, which only surfaces ocVersion) for the
      // native band's runtime-compatibility gate below, and for later Task 4 slices' envelope.
      runtimeCompatible: versionProbe.runtimeCompatible,
      runtimeRequired: versionProbe.runtimeRequired ?? null,
      runtimeCurrent: versionProbe.runtimeCurrent ?? null,
    };
  }

  function collectPorts(gatewayPort) {
    // Sync spawnSync-backed collectors (lsof/ss); each retains its own intrinsic process timeout
    // (5s) and is not wrapped with any cancellation/deadline machinery in this slice.
    return {
      gateway: { port: gatewayPort, ...nativeCollectors.collectListeningPort(gatewayPort) },
      browserCdp: { port: 18800, ...nativeCollectors.collectListeningPort(18800) },
      browserControl: { port: 18791, ...nativeCollectors.collectListeningPort(18791) },
    };
  }

  function projectPortEvidence(evidence) {
    const projected = {
      port: evidence.port,
      valid: evidence.valid === true,
      available: evidence.available === true,
      listening: evidence.listening === true ? true : evidence.listening === false ? false : null,
      process: typeof evidence.process === 'string' ? evidence.process : null,
      pid: Number.isSafeInteger(evidence.pid) ? evidence.pid : null,
      endpoint: typeof evidence.endpoint === 'string' ? evidence.endpoint : null,
      collector: evidence.collector === 'lsof' || evidence.collector === 'ss'
        ? evidence.collector
        : null,
    };
    if (evidence.finding && typeof evidence.finding === 'object') {
      projected.finding = {
        checkId: typeof evidence.finding.checkId === 'string' ? evidence.finding.checkId : '',
        severity: typeof evidence.finding.severity === 'string' ? evidence.finding.severity : '',
        path: typeof evidence.finding.path === 'string' ? evidence.finding.path : '',
        message: typeof evidence.finding.message === 'string' ? evidence.finding.message : '',
      };
    }
    return projected;
  }

  function collectNative(openclawBin, runtimeCompatible) {
    // collectNativeDoctor/collectNativeConfigValidation/collectNativeStatus/
    // collectNativeSecurityAudit (cli/bin/native-diagnostics.js) are sync spawnSync-backed
    // collectors that fail closed to a fixed default shape and never throw for any real command
    // outcome — the core relies on that contract rather than adding defensive try/catch here.
    const nativeDoctor = openclawBin
      ? nativeCollectors.collectNativeDoctor(openclawBin)
      : {
        available: false, checksRun: 0, checksSkipped: 0, findings: [],
      };

    const canRunNativeEvidence = Boolean(openclawBin) && runtimeCompatible === true;
    const nativeConfig = canRunNativeEvidence
      ? nativeCollectors.collectNativeConfigValidation(openclawBin)
      : {
        available: false, valid: null, warnings: [], errors: [],
      };
    const nativeStatus = canRunNativeEvidence
      ? nativeCollectors.collectNativeStatus(openclawBin)
      : { available: false };
    const nativeSecurity = canRunNativeEvidence
      ? nativeCollectors.collectNativeSecurityAudit(openclawBin)
      : { available: false, findings: [] };

    return {
      nativeDoctor, nativeConfig, nativeStatus, nativeSecurity,
    };
  }

  async function collectGateway(config, openclawBin) {
    let gatewayStatus = 'unknown';
    if (openclawBin) {
      gatewayStatus = await openclaw.gatewayStatusText({ executable: openclawBin, timeoutMs: 5000 }) || 'could not check';
    }
    const gatewayPort = config?.gateway?.port || 18789;
    const gatewayPid = await openclaw.gatewayProcesses({ timeoutMs: 5000 });
    const statusLine = (
      gatewayStatus.split('\n').find((line) => /runtime:|listening|running|stopped|not running/i.test(line))
      || gatewayStatus.split('\n')[0]
    ).trim();
    const running = /running.*pid|state active|listening/i.test(gatewayStatus);
    return {
      gatewayStatus, gatewayPort, gatewayPid, statusLine, running,
    };
  }

  async function collectLogs(openclawDir) {
    const logPath = openclawDir ? join(openclawDir, 'logs', 'gateway.log') : null;
    const errLogPath = openclawDir ? join(openclawDir, 'logs', 'gateway.err.log') : null;
    let errorLogs = '';
    let stderrLogs = '';
    let gatewayLogTail = '';
    let logSizeMB = 0;
    let errLogSizeMB = 0;

    if (logPath && await fs.exists(logPath)) {
      try {
        const logStat = await fs.stat(logPath);
        logSizeMB = Math.round(logStat.size / 1024 / 1024);
        const tailContent = (await openclaw.readFileTail(logPath, {
          maxLines: 500,
          maxBytes: 1024 * 1024,
        })).text;
        const lines = tailContent.split('\n');
        errorLogs = lines
          .filter((line) => /error|warn|fail|crash|EADDRINUSE|EACCES/i.test(line))
          .slice(-30)
          .join('\n');
        gatewayLogTail = lines
          .filter((line) => /signal SIGTERM|listening.*PID|config change detected.*reload|update available/i.test(line))
          .slice(-20)
          .join('\n');
      } catch {
        // fail-open: matches the original collector's swallow-and-continue behavior
      }
    }

    if (errLogPath && await fs.exists(errLogPath)) {
      try {
        const errStat = await fs.stat(errLogPath);
        errLogSizeMB = Math.round(errStat.size / 1024 / 1024);
        stderrLogs = (await openclaw.readFileTail(errLogPath, {
          maxLines: 200,
          maxBytes: 1024 * 1024,
        })).text;
      } catch {
        // fail-open
      }
    }

    return {
      errorLogs,
      stderrLogs,
      gatewayLogTail,
      logSizeMB,
      errLogSizeMB,
      hasErrors: errorLogs.length > 0,
      errorLineCount: errorLogs ? errorLogs.split('\n').length : 0,
      hasGatewaySignals: gatewayLogTail.length > 0,
      gatewaySignalLineCount: gatewayLogTail ? gatewayLogTail.split('\n').length : 0,
      hasStderr: stderrLogs.trim().length > 0,
    };
  }

  async function collectWorkspace(config, injectedEnv, home, openclawDir) {
    const workspaceDir = config?.agents?.defaults?.workspace || '';
    let mdFiles = 0;
    let memoryFiles = 0;
    let hasSoul = false;
    let hasAgents = false;
    let workspaceExists = false;

    if (workspaceDir && await fs.exists(workspaceDir)) {
      workspaceExists = true;
      hasSoul = await fs.exists(join(workspaceDir, 'SOUL.md'));
      hasAgents = await fs.exists(join(workspaceDir, 'AGENTS.md'));

      try {
        mdFiles = await fs.countMarkdownFiles(workspaceDir);
      } catch {
        // fail-open
      }

      const memDir = join(workspaceDir, 'memory');
      if (await fs.exists(memDir)) {
        try {
          const memEntries = await fs.readdir(memDir);
          memoryFiles = memEntries.filter((name) => name.endsWith('.md')).length;
        } catch {
          // fail-open
        }
      }
    }

    const plugins = Object.entries(config?.plugins?.entries || {}).map(([name, pluginConfig]) => ({
      name,
      enabled: pluginConfig?.enabled !== false,
    }));
    const expectedCodexHome = openclawDir
      ? join(openclawDir, 'codex-home')
      : join(home, '.openclaw', 'codex-home');
    const shellCodexHomeSet = Boolean(injectedEnv.CODEX_HOME);

    return {
      workspaceDir,
      workspaceExists,
      mdFiles,
      memoryFiles,
      hasSoul,
      hasAgents,
      plugins,
      codexHome: {
        expected: expectedCodexHome,
        shellSet: shellCodexHomeSet,
        matchesExpected: injectedEnv.CODEX_HOME === expectedCodexHome,
      },
    };
  }

  async function readConfig(openclawDir) {
    const configPath = openclawDir ? join(openclawDir, 'openclaw.json') : null;
    let config = null;
    let redactedConfig = null;
    if (configPath && await fs.exists(configPath)) {
      config = await fs.readJson(configPath);
      if (config && typeof config === 'object') {
        const sanitizedCopy = { ...config };
        delete sanitizedCopy.env;
        redactedConfig = redact(sanitizedCopy);
        if (!isPlainObject(redactedConfig)) {
          throw new TypeError('redact must return a plain object for an existing configuration');
        }
      }
    }
    return { config, redactedConfig };
  }

  async function runDiagnostics({ revision, emit } = {}) {
    validateRevision(revision);
    if (emit !== undefined && typeof emit !== 'function') {
      throw new TypeError('emit must be a function');
    }
    emit?.(scanStarted({ revision }));

    // Every started scan must produce exactly one terminal event (scan.completed XOR
    // scan.error), never both and never a second attempt if the sink itself throws while
    // delivering the first one. `terminalEmitted` is set BEFORE the sink is invoked, so a
    // throwing sink still leaves the flag correctly set and the catch below will not retry.
    let terminalEmitted = false;
    const emitTerminal = (event) => {
      terminalEmitted = true;
      emit?.(event);
    };

    try {
      const { home, openclawDir, openclawBin } = await discover();

      if (!openclawBin && !openclawDir) {
        const message = 'OpenClaw not found on this system.';
        emitTerminal(scanError({ revision, error: { message, code: 'OPENCLAW_NOT_FOUND' } }));
        return Object.freeze({ revision, error: message });
      }

      emit?.(scanStep({
        revision,
        phase: 'discover',
        label: 'Finding OpenClaw',
        data: { binary: openclawBin || null, configDir: openclawDir },
      }));

      const system = await collectSystem(openclawBin);
      emit?.(scanStep({
        revision,
        phase: 'system',
        label: 'Collecting system information',
        data: {
          os: system.osName,
          osVersion: system.osVersion,
          arch: system.osArch,
          nodeVersion: system.nodeVersion,
          npmVersion: system.npmVersion,
          ocVersion: system.ocVersion,
          hostHash: system.hostHash,
        },
      }));

      const { config, redactedConfig } = await readConfig(openclawDir);
      emit?.(scanStep({
        revision,
        phase: 'config',
        label: 'Checking configuration',
        data: { configExists: redactedConfig !== null },
      }));

      const gateway = await collectGateway(config, openclawBin);
      emit?.(scanStep({
        revision,
        phase: 'gateway',
        label: 'Checking gateway status',
        data: {
          port: gateway.gatewayPort,
          statusLine: gateway.statusLine,
          pid: gateway.gatewayPid || null,
          running: gateway.running,
        },
      }));

      const logs = await collectLogs(openclawDir);
      emit?.(scanStep({
        revision,
        phase: 'logs',
        label: 'Reading recent logs',
        data: {
          logSizeMB: logs.logSizeMB,
          errLogSizeMB: logs.errLogSizeMB,
          hasErrors: logs.hasErrors,
          errorLineCount: logs.errorLineCount,
          hasGatewaySignals: logs.hasGatewaySignals,
          gatewaySignalLineCount: logs.gatewaySignalLineCount,
          hasStderr: logs.hasStderr,
        },
      }));

      const serviceHealth = await openclaw.serviceManagerState({ timeoutMs: 5000 });
      emit?.(scanStep({
        revision,
        phase: 'service',
        label: 'Checking service health',
        data: {
          manager: serviceHealth.manager ?? null,
          state: serviceHealth.state ?? null,
          subState: serviceHealth.subState ?? null,
          pid: serviceHealth.pid ?? null,
          runs: serviceHealth.runs ?? null,
          nRestarts: serviceHealth.nRestarts ?? null,
          lastExitCode: serviceHealth.lastExitCode ?? null,
          uptimeStr: serviceHealth.uptimeStr ?? null,
          uptimeSeconds: serviceHealth.uptimeSeconds ?? null,
        },
      }));

      const workspace = await collectWorkspace(config, env, home, openclawDir);
      emit?.(scanStep({
        revision,
        phase: 'workspace',
        label: 'Checking workspace',
        data: {
          path: workspace.workspaceDir || null,
          exists: workspace.workspaceExists,
          mdFiles: workspace.mdFiles,
          memoryFiles: workspace.memoryFiles,
          hasSoul: workspace.hasSoul,
          hasAgents: workspace.hasAgents,
          plugins: workspace.plugins,
          codexHome: workspace.codexHome,
        },
      }));

      const ports = collectPorts(gateway.gatewayPort);
      emit?.(scanStep({
        revision,
        phase: 'ports',
        label: 'Checking port availability',
        data: {
          gateway: projectPortEvidence(ports.gateway),
          browserCdp: projectPortEvidence(ports.browserCdp),
          browserControl: projectPortEvidence(ports.browserControl),
        },
      }));

      const {
        nativeDoctor, nativeConfig, nativeStatus, nativeSecurity,
      } = collectNative(openclawBin, system.runtimeCompatible);
      emit?.(scanStep({
        revision,
        phase: 'native',
        label: 'Running OpenClaw native health checks',
        data: {
          doctor: {
            available: nativeDoctor.available,
            checksRun: nativeDoctor.checksRun ?? 0,
            checksSkipped: nativeDoctor.checksSkipped ?? 0,
            findingCount: Array.isArray(nativeDoctor.findings) ? nativeDoctor.findings.length : 0,
          },
          config: {
            available: nativeConfig.available,
            valid: nativeConfig.valid ?? null,
          },
          status: {
            available: nativeStatus.available,
            reachable: nativeStatus.available ? (nativeStatus.gateway?.reachable ?? null) : null,
          },
          security: {
            available: nativeSecurity.available,
            critical: nativeSecurity.available ? (nativeSecurity.summary?.critical ?? 0) : 0,
            warning: nativeSecurity.available ? (nativeSecurity.summary?.warning ?? 0) : 0,
            info: nativeSecurity.available ? (nativeSecurity.summary?.info ?? 0) : 0,
          },
        },
      }));

      const issues = deriveIssues({
        config,
        system,
        gateway,
        logs,
        serviceHealth,
        workspace,
        ports,
        nativeDoctor,
        nativeConfig,
        nativeStatus,
        nativeSecurity,
      });
      const optimizationCount = issues.filter((issue) => issue.kind === 'optimization').length;
      const severity = {
        critical: issues.filter((issue) => issue.severity === 'critical').length,
        high: issues.filter((issue) => issue.severity === 'high').length,
        medium: issues.filter((issue) => issue.severity === 'medium').length,
        low: issues.filter((issue) => issue.severity === 'low').length,
      };
      emit?.(scanStep({
        revision,
        phase: 'issues',
        label: 'Deriving diagnostic issues',
        data: {
          total: issues.length,
          actionable: issues.length - optimizationCount,
          optimizations: optimizationCount,
          severity,
        },
      }));

      const browserConfigured = Boolean(
        openclawDir && await fs.exists(join(openclawDir, 'browser')),
      );
      const now = clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('clock.now() must return a valid Date');
      }

      const diagnosticEnvelope = {
        version,
        timestamp: now.toISOString(),
        hostHash: system.hostHash,
        system: {
          os: system.osName,
          osVersion: system.osVersion,
          arch: system.osArch,
          nodeVersion: system.nodeVersion,
          npmVersion: system.npmVersion,
        },
        openclaw: {
          version: system.ocVersion || 'unknown',
          binary: openclawBin || 'not found',
          configDir: openclawDir || 'not found',
          configExists: config !== null,
          gatewayStatus: gateway.gatewayStatus,
          gatewayPid: gateway.gatewayPid || 'none',
          gatewayPort: gateway.gatewayPort,
          processExists: Boolean(gateway.gatewayPid),
          portListening: ports.gateway.listening === true,
          runtimeCompatible: system.runtimeCompatible,
          runtimeRequired: system.runtimeRequired,
          runtimeCurrent: system.runtimeCurrent,
        },
        config: redactedConfig,
        nativeConfig,
        nativeDoctor,
        nativeStatus,
        nativeSecurity,
        ports,
        logs: {
          errors: logs.errorLogs,
          stderr: logs.stderrLogs,
          gatewayLog: logs.gatewayLogTail,
          errLogSizeMB: logs.errLogSizeMB,
          logSizeMB: logs.logSizeMB,
        },
        service: serviceHealth,
        workspace: {
          path: workspace.workspaceDir || 'unknown',
          exists: workspace.workspaceExists,
          mdFiles: workspace.mdFiles,
          memoryFiles: workspace.memoryFiles,
          hasSoul: workspace.hasSoul,
          hasAgents: workspace.hasAgents,
        },
        browser: {
          status: browserConfigured ? 'configured' : 'not configured',
        },
        codex: {
          expectedHome: workspace.codexHome.expected,
          shellCodexHomeSet: workspace.codexHome.shellSet,
          shellCodexHomeMatchesExpected: workspace.codexHome.matchesExpected,
        },
      };
      const diagnostic = redact(diagnosticEnvelope);
      if (!isPlainObject(diagnostic)) {
        throw new TypeError('redact must return a plain object for the diagnostic envelope');
      }

      const actionableIssueCount = issues.length - optimizationCount;
      const gatewayLabel = gateway.running
        ? `running (pid ${gateway.gatewayPid || '?'}, port ${gateway.gatewayPort})`
        : 'not running';
      const configLabel = config ? 'loaded' : 'not found';
      const issueLabel = actionableIssueCount === 0
        ? optimizationCount > 0
          ? `Healthy; ${optimizationCount} optimization(s)`
          : 'No issues'
        : `${actionableIssueCount} issue(s), ${optimizationCount} optimization(s)`;
      const summary = {
        gateway: {
          running: gateway.running,
          pid: gateway.gatewayPid || null,
          port: gateway.gatewayPort,
          label: gatewayLabel,
        },
        config: {
          loaded: Boolean(config),
          label: configLabel,
        },
        issues: {
          actionable: actionableIssueCount,
          optimizations: optimizationCount,
          label: issueLabel,
        },
        node: system.nodeVersion,
        os: `${system.osName === 'darwin' ? 'macOS' : system.osName} ${system.osVersion}`,
        ocVersion: system.ocVersion || 'unknown',
      };

      emitTerminal(scanCompleted({ revision, summary, findings: issues }));
      return { revision, diagnostic, issues, summary };
    } catch (error) {
      if (!terminalEmitted) {
        emitTerminal(scanError({ revision, error: { message: toSafeErrorMessage(error), code: 'INTERNAL' } }));
      }
      throw error;
    }
  }

  return Object.freeze({ runDiagnostics });
}
