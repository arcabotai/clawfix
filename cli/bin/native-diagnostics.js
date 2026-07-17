import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { redactText } from './security.js';

function cleanText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasAcceptedJsonExitCode(result) {
  return result.status === 0 || result.status === 1;
}

export function redactDiagnosticText(value) {
  return redactText(value);
}

function cleanPath(value) {
  return redactDiagnosticText(cleanText(value, 500)).replaceAll(homedir(), '~');
}

function runJsonCommand(openclawBin, args, spawn, timeout = 30_000) {
  const result = spawn(openclawBin, args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = cleanText(result.stdout, 500_000);
  const stderr = redactDiagnosticText(cleanText(result.stderr || result.error?.message, 2000));

  if (result.error || result.signal || !Number.isInteger(result.status)) {
    return {
      result,
      parsed: null,
      error: stderr || (result.signal ? `Command terminated by ${result.signal}` : 'Command failed before completion'),
    };
  }
  if (!hasAcceptedJsonExitCode(result)) {
    return { result, parsed: null, error: stderr || `Command exited with status ${result.status}` };
  }

  try {
    return { result, parsed: JSON.parse(stdout), error: stderr };
  } catch {
    return { result, parsed: null, error: stderr || (stdout ? 'Command returned invalid JSON' : '') };
  }
}

function normalizeFinding(finding, source) {
  return {
    checkId: cleanText(finding.checkId, 200),
    source,
    severity: ['info', 'warning', 'warn', 'error', 'critical'].includes(finding.severity)
      ? finding.severity
      : 'warning',
    title: redactDiagnosticText(cleanText(finding.title, 500)) || null,
    message: redactDiagnosticText(cleanText(finding.message || finding.detail, 2000)),
    path: cleanPath(finding.path) || null,
    fixHint: redactDiagnosticText(cleanText(finding.fixHint || finding.remediation, 2000)) || null,
  };
}

export function collectOpenClawVersion(openclawBin, spawn = spawnSync) {
  const result = spawn(openclawBin, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const version = cleanText(result.stdout, 300);
  const error = redactDiagnosticText(cleanText(result.stderr || result.error?.message, 1000));
  const mismatch = error.match(/Node\.js (.+?) is required \(current: ([^)]+)\)/i);

  return {
    version,
    runtimeCompatible: result.status === 0 && !mismatch,
    runtimeRequired: mismatch?.[1]?.trim() || null,
    runtimeCurrent: mismatch?.[2]?.trim() || null,
    error: result.status === 0 ? '' : error,
  };
}

export function collectNativeDoctor(openclawBin, spawn = spawnSync) {
  const result = spawn(openclawBin, [
    'doctor',
    '--lint',
    '--json',
    '--severity-min', 'warning',
    '--skip', 'core/doctor/skills-readiness',
    '--no-workspace-suggestions',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = cleanText(result.stdout, 250_000);
  if (result.error || result.signal || !Number.isInteger(result.status) || !hasAcceptedJsonExitCode(result)) {
    return {
      available: false,
      exitCode: result.status,
      error: redactDiagnosticText(cleanText(
        result.stderr || result.error?.message || (result.signal ? `Doctor terminated by ${result.signal}` : `Doctor exited with status ${result.status}`),
        1000,
      )),
      checksRun: 0,
      checksSkipped: 0,
      findings: [],
    };
  }
  if (!stdout) {
    return {
      available: false,
      exitCode: result.status,
      error: redactDiagnosticText(cleanText(result.stderr || result.error?.message, 1000)),
      checksRun: 0,
      checksSkipped: 0,
      findings: [],
    };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (!isRecord(parsed)
      || typeof parsed.ok !== 'boolean'
      || !Number.isSafeInteger(parsed.checksRun)
      || parsed.checksRun < 0
      || !Number.isSafeInteger(parsed.checksSkipped)
      || parsed.checksSkipped < 0
      || !Array.isArray(parsed.findings)) {
      throw new TypeError('invalid Doctor envelope');
    }
    const findings = parsed.findings.slice(0, 100).map(finding => ({
      checkId: cleanText(finding.checkId, 200),
      severity: ['info', 'warning', 'error'].includes(finding.severity)
        ? finding.severity
        : 'warning',
      message: redactDiagnosticText(cleanText(finding.message, 2000)),
      path: cleanPath(finding.path) || null,
      fixHint: redactDiagnosticText(cleanText(finding.fixHint, 2000)) || null,
    }));

    return {
      available: true,
      exitCode: result.status,
      ok: parsed.ok === true,
      checksRun: Number.isSafeInteger(parsed.checksRun) ? parsed.checksRun : 0,
      checksSkipped: Number.isSafeInteger(parsed.checksSkipped) ? parsed.checksSkipped : 0,
      findings,
    };
  } catch {
    return {
      available: false,
      exitCode: result.status,
      error: 'OpenClaw Doctor returned invalid JSON',
      checksRun: 0,
      checksSkipped: 0,
      findings: [],
    };
  }
}

export function collectNativeConfigValidation(openclawBin, spawn = spawnSync) {
  const { result, parsed, error } = runJsonCommand(
    openclawBin,
    ['config', 'validate', '--json'],
    spawn,
    20_000,
  );
  if (!parsed) {
    return {
      available: false,
      exitCode: result.status,
      valid: null,
      warnings: [],
      errors: error ? [error] : [],
    };
  }

  const valid = typeof parsed.valid === 'boolean'
    ? parsed.valid
    : typeof parsed.ok === 'boolean' ? parsed.ok : null;
  if (!isRecord(parsed)
    || valid === null
    || (parsed.issues != null && !Array.isArray(parsed.issues))
    || (parsed.errors != null && !Array.isArray(parsed.errors))
    || (parsed.warnings != null && !Array.isArray(parsed.warnings))) {
    return {
      available: false,
      exitCode: result.status,
      valid: null,
      warnings: [],
      errors: ['OpenClaw config validation returned an invalid JSON envelope'],
    };
  }

  const rawErrors = Array.isArray(parsed.issues)
    ? parsed.issues
    : Array.isArray(parsed.errors) ? parsed.errors : [];
  const rawWarnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  return {
    available: true,
    exitCode: result.status,
    valid,
    path: cleanPath(parsed.path || parsed.configPath) || null,
    warnings: rawWarnings.slice(0, 50).map(item => (
      redactDiagnosticText(cleanText(item?.message || item, 2000))
    )),
    errors: rawErrors.slice(0, 50).map(item => {
      const rawPath = item?.path || item?.ref;
      const path = Array.isArray(rawPath) ? rawPath.join('.') : rawPath;
      return {
        kind: cleanText(item?.kind || item?.code, 100) || 'schema',
        path: cleanPath(path) || null,
        message: redactDiagnosticText(cleanText(item?.message || item?.error || item, 2000)),
      };
    }),
  };
}

export function collectNativeStatus(openclawBin, spawn = spawnSync) {
  const { result, parsed, error } = runJsonCommand(openclawBin, ['status', '--json'], spawn, 30_000);
  if (!parsed) {
    return { available: false, exitCode: result.status, error };
  }
  if (!isRecord(parsed)
    || typeof parsed.runtimeVersion !== 'string'
    || !parsed.runtimeVersion.trim()
    || !isRecord(parsed.gateway)
    || typeof parsed.gateway.reachable !== 'boolean') {
    return {
      available: false,
      exitCode: result.status,
      error: 'OpenClaw status returned an invalid JSON envelope',
    };
  }

  return {
    available: true,
    exitCode: result.status,
    runtimeVersion: cleanText(parsed.runtimeVersion, 100) || null,
    gateway: {
      mode: cleanText(parsed.gateway?.mode, 50) || null,
      reachable: typeof parsed.gateway?.reachable === 'boolean'
        ? parsed.gateway.reachable
        : null,
      misconfigured: parsed.gateway?.misconfigured === true,
      connectLatencyMs: Number.isFinite(parsed.gateway?.connectLatencyMs)
        ? parsed.gateway.connectLatencyMs
        : null,
      error: redactDiagnosticText(cleanText(parsed.gateway?.error, 1000)) || null,
      authWarning: redactDiagnosticText(cleanText(parsed.gateway?.authWarning, 1000)) || null,
    },
    gatewayService: {
      label: cleanText(parsed.gatewayService?.label, 100) || null,
      installed: parsed.gatewayService?.installed === true,
      loaded: parsed.gatewayService?.loaded === true,
      externallyManaged: parsed.gatewayService?.externallyManaged === true,
      status: cleanText(parsed.gatewayService?.runtime?.status, 100) || null,
      detail: redactDiagnosticText(cleanText(parsed.gatewayService?.runtime?.detail, 1000)) || null,
    },
    tasks: {
      total: Number.isSafeInteger(parsed.tasks?.total) ? parsed.tasks.total : 0,
      active: Number.isSafeInteger(parsed.tasks?.active) ? parsed.tasks.active : 0,
      failures: Number.isSafeInteger(parsed.tasks?.failures) ? parsed.tasks.failures : 0,
    },
    secretDiagnosticCount: Array.isArray(parsed.secretDiagnostics)
      ? parsed.secretDiagnostics.length
      : 0,
  };
}

export function collectNativeSecurityAudit(openclawBin, spawn = spawnSync) {
  const { result, parsed, error } = runJsonCommand(
    openclawBin,
    ['security', 'audit', '--json'],
    spawn,
    30_000,
  );
  if (!parsed) {
    return { available: false, exitCode: result.status, error, findings: [] };
  }
  const warningCount = parsed?.summary?.warn ?? parsed?.summary?.warning;
  if (!isRecord(parsed)
    || !isRecord(parsed.summary)
    || !Number.isSafeInteger(parsed.summary.critical)
    || parsed.summary.critical < 0
    || !Number.isSafeInteger(warningCount)
    || warningCount < 0
    || !Number.isSafeInteger(parsed.summary.info)
    || parsed.summary.info < 0
    || !Array.isArray(parsed.findings)) {
    return {
      available: false,
      exitCode: result.status,
      error: 'OpenClaw security audit returned an invalid JSON envelope',
      findings: [],
    };
  }

  return {
    available: true,
    exitCode: result.status,
    summary: {
      critical: Number.isSafeInteger(parsed.summary?.critical) ? parsed.summary.critical : 0,
      warning: Number.isSafeInteger(parsed.summary?.warn)
        ? parsed.summary.warn
        : Number.isSafeInteger(parsed.summary?.warning) ? parsed.summary.warning : 0,
      info: Number.isSafeInteger(parsed.summary?.info) ? parsed.summary.info : 0,
    },
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.slice(0, 100).map(finding => normalizeFinding(finding, 'openclaw-security'))
      : [],
    suppressedFindingCount: Array.isArray(parsed.suppressedFindings)
      ? parsed.suppressedFindings.length
      : 0,
    secretDiagnosticCount: Array.isArray(parsed.secretDiagnostics)
      ? parsed.secretDiagnostics.length
      : 0,
  };
}

export function collectListeningPort(port, spawn = spawnSync) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      valid: false,
      listening: false,
      process: null,
      pid: null,
      endpoint: null,
      collector: null,
      finding: {
        checkId: 'config/gateway-port-invalid',
        severity: 'error',
        path: 'gateway.port',
        message: `Gateway port must be an integer between 1 and 65535; received ${cleanText(port, 100) || String(port)}`,
      },
    };
  }

  const lsof = spawn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lsofLines = cleanText(lsof.stdout, 20_000).split('\n').filter(Boolean);
  if (lsof.status === 0 && lsofLines.length > 1) {
    const fields = lsofLines[1].trim().split(/\s+/);
    const endpoint = lsofLines[1].match(/\b(?:TCP|UDP)\s+(\S+)/)?.[1];
    return {
      valid: true,
      listening: true,
      process: cleanText(fields[0], 100) || null,
      pid: Number.parseInt(fields[1], 10) || null,
      endpoint: cleanText(endpoint, 200) || null,
      collector: 'lsof',
    };
  }

  const ss = spawn('ss', ['-ltnp', `sport = :${port}`], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ssOutput = cleanText(ss.stdout, 20_000);
  const processMatch = ssOutput.match(/users:\(\(\"([^\"]+)\",pid=(\d+)/);
  const endpointMatch = ssOutput.match(/LISTEN\s+\d+\s+\d+\s+(\S+):\d+/);
  if (ss.status === 0 && /\bLISTEN\b/.test(ssOutput)) {
    return {
      valid: true,
      listening: true,
      process: cleanText(processMatch?.[1], 100) || null,
      pid: Number.parseInt(processMatch?.[2], 10) || null,
      endpoint: cleanText(endpointMatch?.[1], 200) || null,
      collector: 'ss',
    };
  }

  return { valid: true, listening: false, process: null, pid: null, endpoint: null, collector: null };
}
