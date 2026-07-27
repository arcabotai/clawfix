import assert from 'node:assert/strict';
import test from 'node:test';

import { claimWebhookDelivery, releaseWebhookDelivery } from '../src/db.js';

function fakeDb() {
  const claimed = new Set();
  return {
    async query(sql, values = []) {
      if (/INSERT INTO webhook_deliveries/.test(sql)) {
        const key = `${values[0]}:${values[1]}`;
        if (claimed.has(key)) return { rowCount: 0, rows: [] };
        claimed.add(key);
        return { rowCount: 1, rows: [{ event_id: values[1] }] };
      }
      if (/DELETE FROM webhook_deliveries WHERE provider/.test(sql)) {
        claimed.delete(`${values[0]}:${values[1]}`);
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

test('webhook delivery claim is durable-idempotent and can be released for retry', async () => {
  const db = fakeDb();
  assert.equal(await claimWebhookDelivery('resend', 'msg_test_1', { db }), true);
  assert.equal(await claimWebhookDelivery('resend', 'msg_test_1', { db }), false);
  await releaseWebhookDelivery('resend', 'msg_test_1', { db });
  assert.equal(await claimWebhookDelivery('resend', 'msg_test_1', { db }), true);
});

test('webhook delivery claim rejects malformed keys before touching storage', async () => {
  let queries = 0;
  const db = { query: async () => { queries += 1; return { rowCount: 1 }; } };
  assert.equal(await claimWebhookDelivery('resend', '../bad', { db }), false);
  assert.equal(queries, 0);
});
