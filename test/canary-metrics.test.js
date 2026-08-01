import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAIRequestGuard,
  isAuthorizedCanaryRequest,
} from '../src/security.js';
import {
  getPublicStatsQueries,
  shouldCountDiagnosisInPublicMetrics,
} from '../src/db.js';
import { diagnosisSource } from '../src/routes/diagnose.js';

function request(headers = {}) {
  return { headers, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
}

test('canary recognition requires a configured exact token and uses fail-closed comparisons', () => {
  const env = { CLAWFIX_CANARY_TOKEN: 'correct-token' };
  assert.equal(
    isAuthorizedCanaryRequest(request({ 'x-clawfix-canary': 'correct-token' }), env),
    true,
  );
  assert.equal(isAuthorizedCanaryRequest(request(), env), false);
  assert.equal(
    isAuthorizedCanaryRequest(request({ 'x-clawfix-canary': 'wrong-token' }), env),
    false,
  );
  assert.equal(
    isAuthorizedCanaryRequest(request({ 'x-clawfix-canary': 'x' }), env),
    false,
  );
  assert.equal(
    isAuthorizedCanaryRequest(request({ 'x-clawfix-canary': ['correct-token'] }), env),
    false,
  );
  assert.equal(
    isAuthorizedCanaryRequest(request({ 'x-clawfix-canary': 'correct-token' }), {}),
    false,
  );
});

test('canary marker classifies storage source but cannot bypass AI bearer authorization', () => {
  const req = request({ 'x-clawfix-canary': 'canary-token', 'user-agent': 'node/test' });
  assert.equal(diagnosisSource(req, { CLAWFIX_CANARY_TOKEN: 'canary-token' }), 'canary');
  assert.equal(diagnosisSource(req, { CLAWFIX_CANARY_TOKEN: 'different' }), 'npx');

  const guard = createAIRequestGuard({ token: 'api-token', dailyLimit: 1, concurrency: 1 });
  const denied = guard.acquire(req);
  assert.deepEqual(denied, { allowed: false, status: 401, error: 'Unauthorized' });
});

test('only authorized non-canary diagnoses contribute to public aggregate state', () => {
  assert.equal(shouldCountDiagnosisInPublicMetrics('canary'), false);
  assert.equal(shouldCountDiagnosisInPublicMetrics('curl'), true);
  assert.equal(shouldCountDiagnosisInPublicMetrics('npx'), true);
  assert.equal(shouldCountDiagnosisInPublicMetrics(undefined), true);
});

test('every diagnosis-backed public stats query excludes canary rows', () => {
  const queries = getPublicStatsQueries();
  for (const [name, sql] of Object.entries(queries)) {
    assert.match(sql, /\bdiagnoses\b/, name);
    assert.match(sql, /source IS DISTINCT FROM 'canary'/, name);
  }
});
