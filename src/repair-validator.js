import { spawnSync } from 'node:child_process';

function clean(value, maxLength = 2000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

export function validateRepairScript(script, {
  spawn = spawnSync,
  runShellCheck = true,
} = {}) {
  const value = String(script || '').trim();
  if (!value) {
    return {
      ok: true,
      syntax: { ok: true },
      shellcheck: { available: false, findings: [] },
      blockers: [],
    };
  }

  const syntaxResult = spawn('bash', ['-n'], {
    encoding: 'utf8',
    input: value,
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const syntax = {
    ok: syntaxResult.status === 0,
    error: syntaxResult.status === 0
      ? null
      : clean(syntaxResult.stderr || syntaxResult.error?.message),
  };

  let shellcheck = { available: false, findings: [] };
  if (runShellCheck) {
    const result = spawn('shellcheck', ['--format=json', '--shell=bash', '-'], {
      encoding: 'utf8',
      input: value,
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!result.error || result.error.code !== 'ENOENT') {
      let findings = [];
      try {
        const parsed = JSON.parse(String(result.stdout || '[]'));
        findings = Array.isArray(parsed)
          ? parsed.slice(0, 100).map(finding => ({
              code: Number.isSafeInteger(finding.code) ? finding.code : null,
              level: ['error', 'warning', 'info', 'style'].includes(finding.level)
                ? finding.level
                : 'warning',
              line: Number.isSafeInteger(finding.line) ? finding.line : null,
              column: Number.isSafeInteger(finding.column) ? finding.column : null,
              message: clean(finding.message, 1000),
            }))
          : [];
      } catch {
        findings = [{
          code: null,
          level: 'error',
          line: null,
          column: null,
          message: clean(result.stderr) || 'ShellCheck returned invalid JSON',
        }];
      }
      shellcheck = { available: true, findings };
    }
  }

  const blockers = [];
  if (!syntax.ok) blockers.push({ source: 'bash', message: syntax.error || 'Invalid Bash syntax' });
  for (const finding of shellcheck.findings) {
    if (finding.level === 'error') {
      blockers.push({ source: 'shellcheck', code: finding.code, message: finding.message });
    }
  }

  return { ok: blockers.length === 0, syntax, shellcheck, blockers };
}
