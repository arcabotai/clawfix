import { spawnSync } from 'node:child_process';

function cleanText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

export function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/\b(?:sk|xai|ghp|gho|ghu|ghs|ghr|npm|m0|ntn)_[A-Za-z0-9_-]{12,}\b/gi, '***REDACTED***')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, '***REDACTED***')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '***REDACTED***')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|jwt)\s*[=:]\s*)([^\s,;]+)/gi, '$1***REDACTED***');
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
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.slice(0, 100).map(finding => ({
          checkId: cleanText(finding.checkId, 200),
          severity: ['info', 'warning', 'error'].includes(finding.severity)
            ? finding.severity
            : 'warning',
          message: redactDiagnosticText(cleanText(finding.message, 2000)),
          path: cleanText(finding.path, 500) || null,
          fixHint: redactDiagnosticText(cleanText(finding.fixHint, 2000)) || null,
        }))
      : [];

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
