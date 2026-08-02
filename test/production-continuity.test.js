import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSseEvents,
  parseVerifierArgs,
  runProductionVerification,
} from '../scripts/verify-production.mjs';

const INSTALLER = '#!/bin/sh\nprintf "ClawFix installer\\n"\n';
const INSTALLER_HASH = createHash('sha256').update(INSTALLER).digest('hex');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function verifierFetch({
  version = '0.11.2',
  installerHash = INSTALLER_HASH,
  rootBody = '<!doctype html><title>ClawFix</title><h1>ClawFix</h1>',
  handler,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, options });
    if (handler) {
      const handled = await handler(parsed, options);
      if (handled) return handled;
    }
    switch (parsed.pathname) {
      case '/':
        return response(rootBody, {
          headers: { 'content-type': 'text/html' },
        });
      case '/api/health':
        return response(JSON.stringify({ status: 'ok', timestamp: '2026-08-01T00:00:00.000Z' }), {
          headers: { 'content-type': 'application/json' },
        });
      case '/api/stats':
        return response(JSON.stringify({ version, totalDiagnoses: 200 }), {
          headers: { 'content-type': 'application/json' },
        });
      case '/install':
        return response(INSTALLER, {
          headers: {
            'content-type': 'text/plain',
            'x-script-sha256': INSTALLER_HASH,
          },
        });
      case '/install/sha256':
        return response(JSON.stringify({ sha256: installerHash }), {
          headers: { 'content-type': 'application/json' },
        });
      default:
        return response('not found', { status: 404 });
    }
  };
  return { fetchImpl, calls };
}

test('free production verification checks root, health, stats, installer, and exact hash', async () => {
  const { fetchImpl, calls } = verifierFetch();
  const report = await runProductionVerification({
    baseUrl: 'https://example.test',
    expectedVersion: '0.11.2',
    fetchImpl,
    timeoutMs: 1_000,
  });

  assert.equal(report.ok, true);
  assert.equal(report.expectedVersion, '0.11.2');
  assert.deepEqual(
    report.checks.map((check) => check.name).sort(),
    ['health', 'installer', 'root', 'stats'].sort(),
  );
  assert.deepEqual(
    calls.map((call) => call.path).sort(),
    ['/', '/api/health', '/api/stats', '/install', '/install/sha256'].sort(),
  );
  assert.ok(calls.every((call) => call.options.redirect === 'error'));
});

test('production verification fails closed on version drift and installer hash mismatch', async () => {
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.12.0',
      fetchImpl: verifierFetch({ version: '0.11.2' }).fetchImpl,
    }),
    /expected version 0\.12\.0, received 0\.11\.2/,
  );

  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      fetchImpl: verifierFetch({ installerHash: '0'.repeat(64) }).fetchImpl,
    }),
    /installer SHA-256 mismatch/,
  );
});

test('remote verification refuses insecure or credential-bearing base URLs before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };

  await assert.rejects(
    runProductionVerification({
      baseUrl: 'http://clawfix.dev',
      expectedVersion: '0.11.2',
      fetchImpl,
    }),
    /must use https/i,
  );
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://user:password@clawfix.dev',
      expectedVersion: '0.11.2',
      fetchImpl,
    }),
    /must not contain credentials/i,
  );
  for (const baseUrl of [
    'https://clawfix.dev/api',
    'https://clawfix.dev/?source=test',
    'https://clawfix.dev/#fragment',
  ]) {
    await assert.rejects(
      runProductionVerification({ baseUrl, expectedVersion: '0.11.2', fetchImpl }),
      /must not contain (?:a path|a query or fragment)/i,
    );
  }
  assert.equal(calls, 0);
});

test('metered canaries never run after a free prerequisite drifts', async () => {
  const { fetchImpl, calls } = verifierFetch({ version: '0.11.2' });
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.12.0',
      meteredMode: 'agent',
      apiToken: 'must-not-be-sent',
      fetchImpl,
    }),
    /expected version 0\.12\.0, received 0\.11\.2/,
  );
  assert.equal(calls.some((call) => call.path === '/api/v2/agent/messages'), false);
});

test('response bodies are rejected while reading once they exceed the verifier limit', async () => {
  const oversized = verifierFetch({
    rootBody: 'C'.repeat((1024 * 1024) + 1),
  });
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      fetchImpl: oversized.fetchImpl,
    }),
    /body exceeded/i,
  );
});

test('production verification rejects malformed health JSON and bounded request timeouts', async () => {
  const malformed = verifierFetch({
    handler(parsed) {
      if (parsed.pathname === '/api/health') {
        return response('{nope', { headers: { 'content-type': 'application/json' } });
      }
      return null;
    },
  });
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      fetchImpl: malformed.fetchImpl,
    }),
    /health returned invalid JSON/,
  );

  const never = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      fetchImpl: never,
      timeoutMs: 10,
    }),
    /timed out/,
  );
});

test('SSE parser requires complete event frames and rejects malformed JSON', () => {
  const events = parseSseEvents([
    'event: agent.meta',
    'data: {"conversationId":"abc"}',
    '',
    'event: assistant.delta',
    'data: {"text":"ok"}',
    '',
    'event: agent.done',
    'data: {"repairProposed":false}',
    '',
    '',
  ].join('\n'));
  assert.deepEqual(events.map((event) => event.event), [
    'agent.meta',
    'assistant.delta',
    'agent.done',
  ]);
  assert.throws(() => parseSseEvents('event: agent.done\ndata: {bad}\n\n'), /invalid SSE JSON/);
  assert.throws(
    () => parseSseEvents('event: agent.done\ndata: {"repairProposed":false}\n'),
    /unterminated SSE frame/,
  );
});

test('agent canary makes exactly one bounded metered request and validates SSE completion', async () => {
  const { fetchImpl, calls } = verifierFetch({
    handler(parsed, options) {
      if (parsed.pathname !== '/api/v2/agent/messages') return null;
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer api-test-token');
      const body = JSON.parse(options.body);
      assert.match(body.conversationId, /^[0-9a-f-]{36}$/);
      assert.equal(body.availableRepairs.length, 0);
      return response([
        'event: agent.meta',
        `data: {"conversationId":"${body.conversationId}"}`,
        '',
        'event: assistant.delta',
        'data: {"text":"healthy"}',
        '',
        'event: agent.done',
        `data: {"conversationId":"${body.conversationId}","repairProposed":false}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const report = await runProductionVerification({
    baseUrl: 'https://example.test',
    expectedVersion: '0.11.2',
    meteredMode: 'agent',
    apiToken: 'api-test-token',
    fetchImpl,
  });
  assert.equal(report.ok, true);
  assert.equal(report.meteredMode, 'agent');
  assert.equal(calls.filter((call) => call.path === '/api/v2/agent/messages').length, 1);
});

test('agent canary rejects whitespace-only assistant output', async () => {
  const { fetchImpl } = verifierFetch({
    handler(parsed, options) {
      if (parsed.pathname !== '/api/v2/agent/messages') return null;
      const { conversationId } = JSON.parse(options.body);
      return response([
        'event: agent.meta',
        `data: {"conversationId":"${conversationId}"}`,
        '',
        'event: assistant.delta',
        'data: {"text":"   \\n\\t"}',
        '',
        'event: agent.done',
        `data: {"conversationId":"${conversationId}","repairProposed":false}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      meteredMode: 'agent',
      fetchImpl,
    }),
    /agent canary returned no assistant text/,
  );
});

test('agent canary rejects duplicate or mismatched protocol terminal events', async (t) => {
  const scenarios = [
    {
      name: 'duplicate agent.meta',
      expected: /exactly one agent\.meta event/,
      events(conversationId) {
        return [
          ['agent.meta', { conversationId }],
          ['agent.meta', { conversationId }],
          ['assistant.delta', { text: 'healthy' }],
          ['agent.done', { conversationId, repairProposed: false }],
        ];
      },
    },
    {
      name: 'duplicate agent.done',
      expected: /exactly one agent\.done event/,
      events(conversationId) {
        return [
          ['agent.meta', { conversationId }],
          ['assistant.delta', { text: 'healthy' }],
          ['agent.done', { conversationId, repairProposed: false }],
          ['agent.done', { conversationId, repairProposed: false }],
        ];
      },
    },
    {
      name: 'mismatched agent.done conversation',
      expected: /agent canary did not complete/,
      events(conversationId) {
        return [
          ['agent.meta', { conversationId }],
          ['assistant.delta', { text: 'healthy' }],
          ['agent.done', { conversationId: 'different-conversation', repairProposed: false }],
        ];
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { fetchImpl } = verifierFetch({
        handler(parsed, options) {
          if (parsed.pathname !== '/api/v2/agent/messages') return null;
          const { conversationId } = JSON.parse(options.body);
          const stream = scenario.events(conversationId)
            .flatMap(([event, data]) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, ''])
            .concat('')
            .join('\n');
          return response(stream, { headers: { 'content-type': 'text/event-stream' } });
        },
      });

      await assert.rejects(
        runProductionVerification({
          baseUrl: 'https://example.test',
          expectedVersion: '0.11.2',
          meteredMode: 'agent',
          fetchImpl,
        }),
        scenario.expected,
      );
    });
  }
});

test('agent canary rejects agent.error even when partial text and agent.done are present', async () => {
  const { fetchImpl } = verifierFetch({
    handler(parsed, options) {
      if (parsed.pathname !== '/api/v2/agent/messages') return null;
      const { conversationId } = JSON.parse(options.body);
      return response([
        'event: agent.meta',
        `data: {"conversationId":"${conversationId}"}`,
        '',
        'event: assistant.delta',
        'data: {"text":"partial"}',
        '',
        'event: agent.error',
        'data: {"error":"provider failed","fatal":true}',
        '',
        'event: agent.done',
        `data: {"conversationId":"${conversationId}","repairProposed":false}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      meteredMode: 'agent',
      fetchImpl,
    }),
    /agent canary emitted agent\.error/,
  );
});

test('agent canary requires agent.done to be the final event', async () => {
  const { fetchImpl } = verifierFetch({
    handler(parsed, options) {
      if (parsed.pathname !== '/api/v2/agent/messages') return null;
      const { conversationId } = JSON.parse(options.body);
      return response([
        'event: agent.meta',
        `data: {"conversationId":"${conversationId}"}`,
        '',
        'event: assistant.delta',
        'data: {"text":"healthy"}',
        '',
        'event: agent.done',
        `data: {"conversationId":"${conversationId}","repairProposed":false}`,
        '',
        'event: assistant.delta',
        'data: {"text":"late"}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      meteredMode: 'agent',
      fetchImpl,
    }),
    /agent\.done must be the final event/,
  );
});

test('agent canary requires agent.meta before assistant output', async () => {
  const { fetchImpl } = verifierFetch({
    handler(parsed, options) {
      if (parsed.pathname !== '/api/v2/agent/messages') return null;
      const { conversationId } = JSON.parse(options.body);
      return response([
        'event: assistant.delta',
        'data: {"text":"early"}',
        '',
        'event: agent.meta',
        `data: {"conversationId":"${conversationId}"}`,
        '',
        'event: agent.done',
        `data: {"conversationId":"${conversationId}","repairProposed":false}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      meteredMode: 'agent',
      fetchImpl,
    }),
    /agent\.meta must be the first event/,
  );
});

test('diagnosis canary requires its own token and never includes it in the body', async () => {
  await assert.rejects(
    runProductionVerification({
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      meteredMode: 'diagnose',
      fetchImpl: verifierFetch().fetchImpl,
    }),
    /CLAWFIX_CANARY_TOKEN is required/,
  );

  const canaryToken = `secret-${randomUUID()}`;
  const { fetchImpl, calls } = verifierFetch({
    handler(parsed, options) {
      if (parsed.pathname !== '/api/diagnose') return null;
      assert.equal(options.headers['x-clawfix-canary'], canaryToken);
      assert.equal(options.body.includes(canaryToken), false);
      return response(JSON.stringify({
        fixId: 'canaryFix12',
        analysis: 'bounded canary',
        canary: true,
        persisted: true,
      }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const report = await runProductionVerification({
    baseUrl: 'https://example.test',
    expectedVersion: '0.11.2',
    meteredMode: 'diagnose',
    canaryToken,
    fetchImpl,
  });
  assert.equal(report.ok, true);
  assert.equal(calls.filter((call) => call.path === '/api/diagnose').length, 1);
  assert.equal(JSON.stringify(report).includes(canaryToken), false);
});

test('diagnosis canary fails unless production acknowledges canary classification and persistence', async () => {
  const canaryToken = `secret-${randomUUID()}`;
  for (const diagnostic of [
    { fixId: 'canaryFix12', analysis: 'bounded canary' },
    { fixId: 'canaryFix12', analysis: 'bounded canary', canary: true, persisted: false },
  ]) {
    const { fetchImpl } = verifierFetch({
      handler(parsed) {
        if (parsed.pathname !== '/api/diagnose') return null;
        return response(JSON.stringify(diagnostic), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await assert.rejects(
      runProductionVerification({
        baseUrl: 'https://example.test',
        expectedVersion: '0.11.2',
        meteredMode: 'diagnose',
        canaryToken,
        fetchImpl,
      }),
      /classification or persistence was not acknowledged/i,
    );
  }
});

test('CLI parsing caps each invocation at one explicit metered mode', () => {
  assert.deepEqual(
    parseVerifierArgs(['--base-url', 'https://example.test', '--expected-version', '0.11.2']),
    {
      baseUrl: 'https://example.test',
      expectedVersion: '0.11.2',
      meteredMode: 'none',
      timeoutMs: 15_000,
    },
  );
  assert.throws(
    () => parseVerifierArgs(['--agent-canary', '--diagnose-canary']),
    /mutually exclusive/,
  );
  assert.throws(() => parseVerifierArgs(['--timeout-ms', '0']), /positive integer/);
});

test('scheduled workflow is free by default and retains machine-readable evidence', async () => {
  const workflow = await readFile(join(ROOT, '.github/workflows/production-smoke.yml'), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /CLAWFIX_SCHEDULED_CANARY: \$\{\{ vars\.CLAWFIX_SCHEDULED_CANARY \}\}/);
  assert.match(workflow, /mode="none"/);
  assert.match(workflow, /production-verification\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});
