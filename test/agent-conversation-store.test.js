import assert from 'node:assert/strict';
import test from 'node:test';

import { pruneConversations } from '../src/routes/agent-v2.js';

function conv(createdAt) {
  return { messages: [], diagnosticId: null, createdAt };
}

test('pruneConversations drops entries past the TTL', () => {
  const now = 1_000_000_000;
  const store = new Map([
    ['fresh-conversation', conv(now - 60_000)],
    ['stale-conversation', conv(now - 31 * 60_000)],
  ]);

  pruneConversations(now, store);

  assert.deepEqual([...store.keys()], ['fresh-conversation']);
});

test('pruneConversations enforces a hard cap, evicting oldest first', () => {
  const now = 1_000_000_000;
  const store = new Map();
  for (let i = 0; i < 1200; i += 1) {
    // All within the TTL, so only the cap can bound this.
    store.set(`conversation-${String(i).padStart(5, '0')}`, conv(now - 1000));
  }

  const size = pruneConversations(now, store);

  assert.equal(size, 1000);
  assert.equal(store.size, 1000);
  // Insertion order is age order, so the first 200 are the ones evicted.
  assert.equal(store.has('conversation-00000'), false);
  assert.equal(store.has('conversation-00199'), false);
  assert.equal(store.has('conversation-00200'), true);
  assert.equal(store.has('conversation-01199'), true);
});

test('pruneConversations leaves a store within both limits untouched', () => {
  const now = 1_000_000_000;
  const store = new Map([['only-conversation', conv(now)]]);
  pruneConversations(now, store);
  assert.equal(store.size, 1);
});
