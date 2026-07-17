import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { app } from '../src/server.js';
import {
  FIX_ID_PATTERN,
  projectLocalIssuesForUpload,
  redactOutbound,
  safeJsonForHtml,
  validateFixId,
} from '../cli/bin/security.js';
import { countMarkdownFiles } from '../cli/bin/workspace.js';
import { parseAIAnalysis } from '../src/ai.js';
import {
  createAIRequestGuard,
  createConcurrencyGate,
  createRateLimiter,
  validateChatBody,
  validateDiagnosticBody,
} from '../src/security.js';

test('recursive outbound redaction covers credentials, private keys, env assignments, and home paths', () => {
  const home = process.env.HOME;
  const input = {
    config: { nested: { password: 'correct horse battery staple' } },
    compoundKeys: {
      clientSecret: 'client-secret-opaque',
      botToken: 'bot-token-opaque',
      githubToken: 'github-token-opaque',
      refreshToken: 'refresh-token-opaque',
      databasePassword: 'database-password-opaque',
      array: [{ sessionToken: 'nested-session-token' }],
    },
    log: [
      'Authorization: Bearer bearer-secret-value',
      'clone https://alice:super-secret@example.com/org/repo.git',
      'OPENROUTER_API_KEY = sk-or-v1-abcdefghijklmnop',
      '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
      `${home}/.openclaw/logs/gateway.log`,
    ].join('\n'),
    native: [{ path: `${home}/private/workspace`, message: 'token = token-secret-value' }],
  };

  const redacted = redactOutbound(input, { home });
  const serialized = JSON.stringify(redacted);
  for (const secret of ['correct horse', 'bearer-secret', 'super-secret', 'sk-or-v1', 'private-material', home]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(redacted.log, /Authorization: Bearer \*\*\*REDACTED\*\*\*/);
  assert.match(redacted.log, /~\/\.openclaw/);
  for (const value of Object.values(redacted.compoundKeys).flatMap(item => (
    Array.isArray(item) ? item.map(entry => entry.sessionToken) : [item]
  ))) {
    assert.equal(value, '***REDACTED***');
  }
});

test('local issue upload projection preserves only validated matcher IDs', () => {
  const projected = projectLocalIssuesForUpload([
    {
      severity: 'high',
      kind: 'failure',
      text: 'Native Codex timeout can force gateway fallback',
      knownIssueId: 'native-codex-timeout-boundary',
      nativeCheckId: 'core/doctor/gateway-config',
      issueId: 'discard-me',
      repair: 'discard-me-too',
    },
    { text: 'invalid IDs', knownIssueId: '../escape', nativeCheckId: 'bad id' },
  ]);
  assert.deepEqual(projected[0], {
    severity: 'high',
    kind: 'failure',
    text: 'Native Codex timeout can force gateway fallback',
    knownIssueId: 'native-codex-timeout-boundary',
    nativeCheckId: 'core/doctor/gateway-config',
  });
  assert.equal('knownIssueId' in projected[1], false);
  assert.equal('nativeCheckId' in projected[1], false);
});

test('redaction does not mutate caller data and handles cycles safely', () => {
  const input = { token: 'very-secret-token-value', nested: {} };
  input.nested.parent = input;
  const output = redactOutbound(input);
  assert.equal(input.token, 'very-secret-token-value');
  assert.equal(output.token, '***REDACTED***');
  assert.equal(output.nested.parent, '[Circular]');
});

test('AI shell is ignored even when valid-looking and never reaches parsed analysis', () => {
  const parsed = parseAIAnalysis(JSON.stringify({
    summary: 'Review the gateway state.',
    insights: 'Check service logs locally.',
    additionalIssues: [],
    additionalFixes: 'echo model-controlled-shell',
  }));
  assert.equal(parsed.additionalFixes, '');
});

test('fix IDs are NanoID-like and safe for HTML serialization', () => {
  assert.match('Abc_123-xYz9', FIX_ID_PATTERN);
  assert.equal(validateFixId('Abc_123-xYz9'), 'Abc_123-xYz9');
  for (const value of ['', 'short', '../escape', 'abc";alert(1)//', 'a'.repeat(65)]) {
    assert.equal(validateFixId(value), null);
  }
  const serialized = safeJsonForHtml('</script><script>alert(1)</script>');
  assert.equal(serialized.includes('</script>'), false);
  assert.match(serialized, /\\u003c/);
});

test('workspace markdown traversal treats metacharacters as a path, not shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-workspace-'));
  const malicious = join(root, 'workspace"; touch SHOULD_NOT_EXIST; #');
  await mkdir(join(malicious, 'nested'), { recursive: true });
  await writeFile(join(malicious, 'one.md'), 'one');
  await writeFile(join(malicious, 'nested', 'two.MD'), 'two');
  await writeFile(join(malicious, 'nested', 'skip.txt'), 'skip');
  assert.equal(await countMarkdownFiles(malicious), 2);
  assert.equal(await countMarkdownFiles(join(root, 'missing')), 0);
});

test('diagnostic and chat validators enforce strict practical limits', () => {
  assert.equal(validateDiagnosticBody({ system: { os: 'linux' } }).ok, true);
  assert.equal(validateDiagnosticBody({}).ok, false);
  assert.equal(validateDiagnosticBody({ system: { os: 'x'.repeat(101) } }).ok, false);
  assert.equal(validateDiagnosticBody({ system: { os: 'linux' }, logs: { errors: 'x'.repeat(100_001) } }).ok, false);

  assert.equal(validateChatBody({ message: 'help', conversationId: '123e4567-e89b-42d3-a456-426614174000' }).ok, true);
  assert.equal(validateChatBody({ message: 'x'.repeat(4001), conversationId: '123e4567-e89b-42d3-a456-426614174000' }).ok, false);
  assert.equal(validateChatBody({ message: 'help', conversationId: '../shared' }).ok, false);
});

test('rate limiter and concurrency gate fail closed at configured budgets', async () => {
  let now = 1_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.consume('ip').allowed, true);
  assert.equal(limiter.consume('ip').allowed, true);
  assert.equal(limiter.consume('ip').allowed, false);
  now += 1001;
  assert.equal(limiter.consume('ip').allowed, true);

  const bounded = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => now });
  assert.equal(bounded.consume('a').allowed, true);
  assert.equal(bounded.consume('b').allowed, true);
  assert.equal(bounded.consume('c').allowed, false);
  now += 1001;
  assert.equal(bounded.consume('c').allowed, true);

  const gate = createConcurrencyGate(1);
  const release = gate.tryAcquire();
  assert.equal(typeof release, 'function');
  assert.equal(gate.tryAcquire(), null);
  release();
  assert.equal(typeof gate.tryAcquire(), 'function');
});

test('shared AI request guard enforces bearer auth, daily spend, and concurrency', () => {
  let now = 1_000;
  const guard = createAIRequestGuard({
    token: 'server-secret',
    dailyLimit: 2,
    concurrency: 1,
    now: () => now,
  });
  assert.equal(guard.acquire({ headers: {} }).status, 401);
  assert.equal(guard.acquire({ headers: { authorization: 'Bearer wrong' } }).status, 401);

  const req = { headers: { authorization: 'Bearer server-secret' } };
  const first = guard.acquire(req);
  assert.equal(first.allowed, true);
  assert.equal(guard.acquire(req).status, 503);
  first.release();

  const second = guard.acquire(req);
  assert.equal(second.allowed, true);
  second.release();
  assert.equal(guard.acquire(req).status, 429);

  now += 86_400_001;
  const reset = guard.acquire(req);
  assert.equal(reset.allowed, true);
  reset.release();
});

test('HTML routes reject attacker-controlled fix IDs and do not enable cross-origin API calls', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  for (const route of ['/results/%22%3Balert(1)%3B%2F%2F', '/pay/%22%3Balert(1)%3B%2F%2F']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 400, route);
    assert.equal((await response.text()).includes('alert(1)'), false, route);
  }

  const checkout = await fetch(base + '/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fixId: '";alert(1);//' }),
  });
  assert.equal(checkout.status, 400);

  const crossOrigin = await fetch(base + '/api/stats', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(crossOrigin.headers.has('access-control-allow-origin'), false);
});
