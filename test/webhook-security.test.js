import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { safeEqual, verifySvixSignature } from '../src/webhook-signatures.js';

const RAW = Buffer.from('{"meta":{"custom_data":{"fix_id":"abcdefghij"}},"data":{}}', 'utf8');

// ============================================================
// Svix (Resend)
// ============================================================

function svixSign({ secret, id, timestamp, rawBody }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]);
  return `v1,${createHmac('sha256', key).update(signed).digest('base64')}`;
}

const SVIX_SECRET = `whsec_${Buffer.from('a-shared-webhook-secret').toString('base64')}`;
const NOW = 1_800_000_000_000;
const TS = Math.floor(NOW / 1000);

test('svix: a correctly signed delivery is accepted', () => {
  const id = 'msg_123';
  const signature = svixSign({ secret: SVIX_SECRET, id, timestamp: TS, rawBody: RAW });
  const result = verifySvixSignature({
    secret: SVIX_SECRET, rawBody: RAW, id, timestamp: String(TS), signature, now: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test('svix: present-but-unverified headers are rejected — the old check only looked for these', () => {
  const result = verifySvixSignature({
    secret: SVIX_SECRET,
    rawBody: RAW,
    id: 'msg_123',
    timestamp: String(TS),
    signature: 'v1,Zm9yZ2Vk',
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('svix: an unset secret fails closed', () => {
  const result = verifySvixSignature({
    secret: undefined, rawBody: RAW, id: 'a', timestamp: String(TS), signature: 'v1,x', now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('svix: a stale timestamp is refused so a captured delivery cannot be replayed', () => {
  const id = 'msg_123';
  const oldTs = TS - 3600;
  const signature = svixSign({ secret: SVIX_SECRET, id, timestamp: oldTs, rawBody: RAW });
  const result = verifySvixSignature({
    secret: SVIX_SECRET, rawBody: RAW, id, timestamp: String(oldTs), signature, now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('svix: a signature bound to a different body does not transfer', () => {
  const id = 'msg_123';
  const signature = svixSign({ secret: SVIX_SECRET, id, timestamp: TS, rawBody: RAW });
  const tampered = Buffer.from(RAW.toString().replace('abcdefghij', 'zzzzzzzzzz'), 'utf8');
  const result = verifySvixSignature({
    secret: SVIX_SECRET, rawBody: tampered, id, timestamp: String(TS), signature, now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('svix: a signature bound to a different message id does not transfer', () => {
  const signature = svixSign({ secret: SVIX_SECRET, id: 'msg_123', timestamp: TS, rawBody: RAW });
  const result = verifySvixSignature({
    secret: SVIX_SECRET, rawBody: RAW, id: 'msg_456', timestamp: String(TS), signature, now: NOW,
  });
  assert.equal(result.ok, false);
});

test('svix: multiple versioned signatures are tolerated when one matches', () => {
  const id = 'msg_123';
  const good = svixSign({ secret: SVIX_SECRET, id, timestamp: TS, rawBody: RAW });
  const signature = `v1,c3RhbGU= ${good}`;
  assert.equal(
    verifySvixSignature({ secret: SVIX_SECRET, rawBody: RAW, id, timestamp: String(TS), signature, now: NOW }).ok,
    true,
  );
});

// ============================================================
// Comparison primitive
// ============================================================

test('safeEqual matches only identical values and tolerates length differences', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(undefined, ''), true);
  assert.equal(safeEqual('abc', undefined), false);
});
