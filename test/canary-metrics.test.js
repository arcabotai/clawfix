import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAIRequestGuard,
  isAuthorizedCanaryRequest,
} from '../src/security.js';
import {
  getDiagnosis,
  getPublicStatsQueries,
  shouldCountDiagnosisInPublicMetrics,
  storeDiagnosis,
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

test('canary persistence reports failure when durable storage is unavailable', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.equal(await storeDiagnosis({ fixId: 'canaryFix12' }, 'canary'), false);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test('rehydrated canaries retain their source and stay out of fallback memory counts', async () => {
  const row = {
    id: 'canaryRehydrated12',
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    issues_count: 0,
    known_issues_detail: [],
    issues_pattern: [],
    ai_summary: 'canary',
    source: 'canary',
  };
  const db = {
    async query(sql) {
      assert.match(sql, /FROM diagnoses/);
      return { rows: [row] };
    },
  };
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const rehydrated = await getDiagnosis(row.id, db);
    assert.equal(rehydrated?._source, 'canary');
    const fallbackPublicCount = [rehydrated]
      .filter((fix) => fix?._source !== 'canary')
      .length;
    assert.equal(fallbackPublicCount, 0);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
