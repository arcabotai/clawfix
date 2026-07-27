export const LEGACY_CHAT_CONVERSATION_TTL_MS = 30 * 60 * 1000;
export const LEGACY_CHAT_MAX_CONVERSATIONS = 500;

export function pruneLegacyConversations(
  store,
  {
    now = Date.now(),
    ttlMs = LEGACY_CHAT_CONVERSATION_TTL_MS,
    maxEntries = LEGACY_CHAT_MAX_CONVERSATIONS,
  } = {},
) {
  for (const [key, conversation] of store) {
    const touchedAt = Number(conversation?.lastSeenAt || conversation?.createdAt || 0);
    if (!Number.isFinite(touchedAt) || now - touchedAt > ttlMs) store.delete(key);
  }
  if (store.size <= maxEntries) return;
  const overflow = [...store.entries()]
    .sort((a, b) => {
      const aTouched = Number(a[1]?.lastSeenAt || a[1]?.createdAt || 0);
      const bTouched = Number(b[1]?.lastSeenAt || b[1]?.createdAt || 0);
      return aTouched - bTouched;
    })
    .slice(0, store.size - maxEntries);
  for (const [key] of overflow) store.delete(key);
}
