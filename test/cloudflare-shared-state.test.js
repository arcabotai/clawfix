import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearRuntimeEnv,
  getRuntimeValue,
  resolveDatabaseUrl,
  setRuntimeEnv,
} from '../src/runtime-env.js';
import {
  acquireConcurrencyLease,
  appendConversationMessage,
  beginConversationTurn,
  consumeFixedWindow,
  cleanupSharedState,
} from '../src/shared-state.js';
import { createHyperdriveDatabase } from '../src/database-connection.js';

test.afterEach(() => clearRuntimeEnv());

test('runtime bindings override Node env and Hyperdrive wins over DATABASE_URL', () => {
  setRuntimeEnv({
    AI_MODEL: 'worker-model',
    DATABASE_URL: 'postgres://worker-direct',
    HYPERDRIVE: { connectionString: 'postgres://hyperdrive' },
  });

  assert.equal(getRuntimeValue('AI_MODEL', { AI_MODEL: 'node-model' }), 'worker-model');
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: 'postgres://node-direct' }), 'postgres://hyperdrive');
});

test('runtime env falls back to process-style env when no Worker binding exists', () => {
  assert.equal(getRuntimeValue('AI_MODEL', { AI_MODEL: 'node-model' }), 'node-model');
  assert.equal(resolveDatabaseUrl({ DATABASE_URL: 'postgres://node-direct' }), 'postgres://node-direct');
});

test('legacy durable conversation rejects a diagnostic mismatch without appending', async () => {
  const first = await beginConversationTurn({
    route: 'legacy-chat', id: 'conversation', diagnosticId: 'diag-one',
    message: { role: 'user', content: 'first' }, db: null, now: 1,
  });
  const mismatch = await beginConversationTurn({
    route: 'legacy-chat', id: 'conversation', diagnosticId: 'diag-two',
    message: { role: 'user', content: 'second' }, db: null, now: 2,
  });

  assert.equal(first.ok, true);
  assert.deepEqual(first.conversation.messages, [{ role: 'user', content: 'first' }]);
  assert.deepEqual(mismatch, { ok: false, reason: 'diagnostic_mismatch' });
});

test('agent-v2 conversation resets history when a new diagnostic is supplied', async () => {
  const first = await beginConversationTurn({
    route: 'agent-v2', id: 'agent-conversation', diagnosticId: 'diag-one',
    message: { role: 'user', content: 'first' }, db: null, now: 10,
  });
  await appendConversationMessage({
    route: 'agent-v2', id: 'agent-conversation',
    message: { role: 'assistant', content: 'answer' }, db: null, now: 11,
  });
  const rescanned = await beginConversationTurn({
    route: 'agent-v2', id: 'agent-conversation', diagnosticId: 'diag-two',
    message: { role: 'user', content: 'after rescan' }, db: null, now: 12,
  });

  assert.equal(first.ok, true);
  assert.equal(rescanned.conversation.diagnosticId, 'diag-two');
  assert.deepEqual(rescanned.conversation.messages, [{ role: 'user', content: 'after rescan' }]);
});

test('no-DB fixed-window fallback enforces the limit and resets at the boundary', async () => {
  const options = { scope: 'chat-ip', key: '127.0.0.1', limit: 2, windowMs: 1000, db: null };
  assert.equal((await consumeFixedWindow({ ...options, now: 1000 })).allowed, true);
  assert.equal((await consumeFixedWindow({ ...options, now: 1001 })).allowed, true);
  assert.equal((await consumeFixedWindow({ ...options, now: 1002 })).allowed, false);
  assert.equal((await consumeFixedWindow({ ...options, now: 2000 })).allowed, true);
});

test('no-DB leased concurrency fallback releases capacity idempotently', async () => {
  const first = await acquireConcurrencyLease({ scope: 'ai', limit: 1, ttlMs: 1000, db: null, now: 1000 });
  const blocked = await acquireConcurrencyLease({ scope: 'ai', limit: 1, ttlMs: 1000, db: null, now: 1001 });
  assert.equal(first.allowed, true);
  assert.equal(blocked.allowed, false);
  await first.release();
  await first.release();
  const next = await acquireConcurrencyLease({ scope: 'ai', limit: 1, ttlMs: 1000, db: null, now: 1002 });
  assert.equal(next.allowed, true);
  await next.release();
});

test('database lease release remains retryable after a transient delete failure', async () => {
  let deletes = 0;
  const client = {
    async query(sql) {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 0 }] };
      return { rows: [] };
    },
    release() {},
  };
  const db = {
    async connect() { return client; },
    async query(sql) {
      if (/DELETE FROM concurrency_leases WHERE scope/.test(sql)) {
        deletes += 1;
        if (deletes === 1) throw new Error('transient delete failure');
      }
      return { rows: [] };
    },
  };

  const lease = await acquireConcurrencyLease({
    scope: 'retryable', limit: 1, ttlMs: 1000, db, now: 1000,
  });
  await assert.rejects(lease.release(), /transient delete failure/);
  await lease.release();
  assert.equal(deletes, 2);
});

test('Hyperdrive adapter creates and closes a Client for each standalone query', async () => {
  const events = [];
  class FakeClient {
    constructor(options) { events.push(['construct', options.connectionString]); }
    async connect() { events.push(['connect']); }
    async query(sql, values) { events.push(['query', sql, values]); return { rows: [{ ok: true }] }; }
    async end() { events.push(['end']); }
  }
  const db = createHyperdriveDatabase(FakeClient, 'postgres://hyperdrive');
  const result = await db.query('SELECT $1', [1]);

  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.deepEqual(events.map(event => event[0]), ['construct', 'connect', 'query', 'end']);
});

test('Hyperdrive transaction client stays open until release and failed queries still close', async () => {
  let ends = 0;
  class FakeClient {
    async connect() {}
    async query(sql) {
      if (sql === 'FAIL') throw new Error('query failed');
      return { rows: [] };
    }
    async end() { ends += 1; }
  }
  const db = createHyperdriveDatabase(FakeClient, 'postgres://hyperdrive');
  const client = await db.connect();
  await client.query('BEGIN');
  assert.equal(ends, 0);
  await client.release();
  assert.equal(ends, 1);
  await assert.rejects(db.query('FAIL'), /query failed/);
  assert.equal(ends, 2);
});

test('shared-state cleanup enforces TTL, per-route caps, and expired coordination rows', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push([sql, values]); return { rows: [] }; } };
  await cleanupSharedState({ db, now: 2_000_000, ttlMs: 1_800_000, legacyMax: 500, agentMax: 1000 });
  assert.equal(calls.length, 3);
  assert.match(calls[0][0], /DELETE FROM conversations/);
  assert.match(calls[1][0], /ROW_NUMBER\(\) OVER \(PARTITION BY route/);
  assert.match(calls[2][0], /rate_limit_windows/);
  assert.deepEqual(calls[0][1], [200_000]);
  assert.deepEqual(calls[1][1], [500, 1000]);
});

test('transaction operation waits for asynchronous client release', async () => {
  let signalReleaseStarted;
  const releaseStarted = new Promise(resolve => { signalReleaseStarted = resolve; });
  let finishRelease;
  const releaseGate = new Promise(resolve => { finishRelease = resolve; });
  const client = {
    async query(sql) {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 0 }] };
      return { rows: [] };
    },
    async release() {
      signalReleaseStarted();
      await releaseGate;
    },
  };
  const db = { async connect() { return client; } };
  let settled = false;
  const pending = acquireConcurrencyLease({
    scope: 'await-release', limit: 1, ttlMs: 1000, db, now: 1000,
  }).then(value => { settled = true; return value; });

  await releaseStarted;
  assert.equal(settled, false);
  finishRelease();
  const lease = await pending;
  assert.equal(lease.allowed, true);
});

test('transaction operation observes client release rejection', async () => {
  const client = {
    async query(sql) {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 0 }] };
      return { rows: [] };
    },
    async release() { throw new Error('release failed'); },
  };
  const db = { async connect() { return client; } };
  await assert.rejects(
    acquireConcurrencyLease({ scope: 'release-error', limit: 1, ttlMs: 1000, db, now: 1000 }),
    /release failed/,
  );
});
