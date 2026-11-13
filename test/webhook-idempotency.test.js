import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimWebhookDelivery,
  completeWebhookDelivery,
  releaseWebhookDelivery,
} from '../src/db.js';

function fakeDb() {
  const deliveries = new Map();
  return {
    async query(sql, values = []) {
      if (/INSERT INTO webhook_deliveries/.test(sql)) {
        const key = `${values[0]}:${values[1]}`;
        if (deliveries.has(key)) return { rowCount: 0, rows: [] };
        deliveries.set(key, { status: 'pending', claimed_at: new Date(values[2]) });
        return { rowCount: 1, rows: [{ event_id: values[1] }] };
      }
      if (/SELECT status, claimed_at FROM webhook_deliveries/.test(sql)) {
        const row = deliveries.get(`${values[0]}:${values[1]}`);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (/SET status = 'completed'/.test(sql)) {
        const row = deliveries.get(`${values[0]}:${values[1]}`);
        if (!row || row.status !== 'pending') return { rowCount: 0, rows: [] };
        row.status = 'completed';
        return { rowCount: 1, rows: [] };
      }
      if (/SET claimed_at =/.test(sql)) return { rowCount: 0, rows: [] };
      if (/DELETE FROM webhook_deliveries WHERE provider/.test(sql)) {
        deliveries.delete(`${values[0]}:${values[1]}`);
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

test('webhook delivery claim distinguishes claimed and completed duplicate', async () => {
  const db = fakeDb();
  assert.deepEqual(await claimWebhookDelivery('resend', 'msg_test_1', { db }), { status: 'claimed' });
  await completeWebhookDelivery('resend', 'msg_test_1', { db });
  assert.deepEqual(await claimWebhookDelivery('resend', 'msg_test_1', { db }), { status: 'duplicate' });
});

test('webhook delivery claim reports storage failure instead of acknowledging duplicate', async () => {
  const db = { query: async () => { throw new Error('database unavailable'); } };
  assert.deepEqual(
    await claimWebhookDelivery('resend', 'msg_test_2', { db }),
    { status: 'storage_error' },
  );
});

test('webhook pending claim asks the provider to retry and can be released', async () => {
  const db = fakeDb();
  assert.deepEqual(await claimWebhookDelivery('resend', 'msg_test_3', { db }), { status: 'claimed' });
  assert.deepEqual(await claimWebhookDelivery('resend', 'msg_test_3', { db }), { status: 'pending' });
  await releaseWebhookDelivery('resend', 'msg_test_1', { db });
  await releaseWebhookDelivery('resend', 'msg_test_3', { db });
  assert.deepEqual(await claimWebhookDelivery('resend', 'msg_test_3', { db }), { status: 'claimed' });
});

test('webhook delivery claim rejects malformed keys before touching storage', async () => {
  let queries = 0;
  const db = { query: async () => { queries += 1; return { rowCount: 1 }; } };
  assert.deepEqual(await claimWebhookDelivery('resend', '../bad', { db }), { status: 'invalid' });
  assert.equal(queries, 0);
});
