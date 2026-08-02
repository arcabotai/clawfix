import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_CHAT_CONVERSATION_TTL_MS,
  pruneLegacyConversations,
} from '../src/conversation-store.js';

function conversation(touchedAt) {
  return { messages: [], diagnosticId: null, createdAt: touchedAt, lastSeenAt: touchedAt };
}

test('legacy chat pruning removes expired entries on every route path', () => {
  const now = 10_000_000;
  const store = new Map([
    ['expired', conversation(now - LEGACY_CHAT_CONVERSATION_TTL_MS - 1)],
    ['fresh', conversation(now - 1)],
  ]);

  pruneLegacyConversations(store, { now });

  assert.equal(store.has('expired'), false);
  assert.equal(store.has('fresh'), true);
});

test('legacy chat pruning caps entries by last activity even without a successful AI response', () => {
  const store = new Map();
  for (let index = 0; index < 6; index += 1) {
    store.set(`conversation-${index}`, conversation(index + 1));
  }

  pruneLegacyConversations(store, { now: 10, ttlMs: 100, maxEntries: 3 });

  assert.deepEqual([...store.keys()], ['conversation-3', 'conversation-4', 'conversation-5']);
});

test('legacy chat pruning treats lastSeenAt as the activity clock', () => {
  const now = 10_000_000;
  const active = conversation(now - LEGACY_CHAT_CONVERSATION_TTL_MS - 1);
  active.lastSeenAt = now;
  const store = new Map([['active', active]]);

  pruneLegacyConversations(store, { now });

  assert.equal(store.has('active'), true);
});
