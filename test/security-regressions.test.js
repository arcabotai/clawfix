import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FIX_ID_PATTERN,
  redactOutbound,
  safeJsonForHtml,
  validateFixId,
} from '../cli/bin/security.js';
import { countMarkdownFiles } from '../cli/bin/workspace.js';
import { parseAIAnalysis } from '../src/ai.js';
import {
  createConcurrencyGate,
  createRateLimiter,
  validateChatBody,
  validateDiagnosticBody,
} from '../src/security.js';

test('recursive outbound redaction covers credentials, private keys, env assignments, and home paths', () => {
  const home = process.env.HOME;
  const input = {
    config: { nested: { password: 'correct horse battery staple' } },
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

  const gate = createConcurrencyGate(1);
  const release = gate.tryAcquire();
  assert.equal(typeof release, 'function');
  assert.equal(gate.tryAcquire(), null);
  release();
  assert.equal(typeof gate.tryAcquire(), 'function');
});
