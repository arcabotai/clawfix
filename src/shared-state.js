const LOCAL_CONVERSATION_TTL_MS = 30 * 60_000;
const LOCAL_CONVERSATION_MAX = 1000;
const LOCAL_LIMIT_MAX = 10_000;

const localConversations = new Map();
const localWindows = new Map();
const localLeases = new Map();

export async function cleanupSharedState({
  db,
  now = Date.now(),
  ttlMs = LOCAL_CONVERSATION_TTL_MS,
  legacyMax = 500,
  agentMax = 1000,
} = {}) {
  if (!db) {
    pruneLocalConversations(now);
    pruneLocalLeases('ai-global', now);
    return false;
  }
  await db.query(
    'DELETE FROM conversations WHERE touched_at < to_timestamp($1 / 1000.0)',
    [now - ttlMs],
  );
  await db.query(`
    WITH ranked AS (
      SELECT route, id,
        ROW_NUMBER() OVER (PARTITION BY route ORDER BY touched_at DESC, id DESC) AS position
      FROM conversations
    )
    DELETE FROM conversations AS conversation
    USING ranked
    WHERE conversation.route = ranked.route
      AND conversation.id = ranked.id
      AND (
        (ranked.route = 'legacy-chat' AND ranked.position > $1)
        OR (ranked.route = 'agent-v2' AND ranked.position > $2)
      )
  `, [legacyMax, agentMax]);
  await db.query(`
    WITH expired_windows AS (
      DELETE FROM rate_limit_windows WHERE expires_at <= NOW()
    )
    DELETE FROM concurrency_leases WHERE expires_at <= NOW()
  `);
  return true;
}

function conversationKey(route, id) {
  return `${route}:${id}`;
}

function trimMessages(messages) {
  return messages.slice(-12);
}

function pruneLocalConversations(now) {
  for (const [key, value] of localConversations) {
    if (now - value.lastSeenAt > LOCAL_CONVERSATION_TTL_MS) localConversations.delete(key);
  }
  while (localConversations.size >= LOCAL_CONVERSATION_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, value] of localConversations) {
      if (value.lastSeenAt < oldestTime) {
        oldestKey = key;
        oldestTime = value.lastSeenAt;
      }
    }
    if (!oldestKey) break;
    localConversations.delete(oldestKey);
  }
}

function normalizeMessages(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function withClient(db, operation) {
  if (typeof db.connect !== 'function') return operation(db);
  const client = await db.connect();
  try {
    return await operation(client);
  } finally {
    await client.release();
  }
}

export async function beginConversationTurn({ route, id, diagnosticId = null, message, db, now = Date.now() }) {
  const normalizedDiagnosticId = diagnosticId || null;
  if (!db) {
    pruneLocalConversations(now);
    const key = conversationKey(route, id);
    let conversation = localConversations.get(key);
    if (!conversation) {
      conversation = { diagnosticId: normalizedDiagnosticId, messages: [], createdAt: now, lastSeenAt: now };
      localConversations.set(key, conversation);
    } else if (route === 'legacy-chat' && conversation.diagnosticId !== normalizedDiagnosticId) {
      return { ok: false, reason: 'diagnostic_mismatch' };
    } else if (route === 'agent-v2' && normalizedDiagnosticId && conversation.diagnosticId !== normalizedDiagnosticId) {
      if (conversation.diagnosticId) conversation.messages = [];
      conversation.diagnosticId = normalizedDiagnosticId;
    }
    conversation.lastSeenAt = now;
    conversation.messages = trimMessages([...conversation.messages, message]);
    return { ok: true, conversation: { ...conversation, messages: [...conversation.messages] } };
  }

  await cleanupSharedState({ db, now });
  return withClient(db, async client => {
    await client.query('BEGIN');
    try {
      await client.query(`
        INSERT INTO conversations (route, id, diagnostic_id, messages, created_at, touched_at)
        VALUES ($1, $2, $3, '[]'::jsonb, NOW(), NOW())
        ON CONFLICT (route, id) DO NOTHING
      `, [route, id, normalizedDiagnosticId]);
      const selected = await client.query(`
        SELECT diagnostic_id, messages FROM conversations
        WHERE route = $1 AND id = $2
        FOR UPDATE
      `, [route, id]);
      const row = selected.rows[0];
      if (!row) throw new Error('Conversation row unavailable');
      if (route === 'legacy-chat' && row.diagnostic_id !== normalizedDiagnosticId) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'diagnostic_mismatch' };
      }
      let boundDiagnosticId = row.diagnostic_id;
      let messages = normalizeMessages(row.messages);
      if (route === 'agent-v2' && normalizedDiagnosticId && boundDiagnosticId !== normalizedDiagnosticId) {
        if (boundDiagnosticId) messages = [];
        boundDiagnosticId = normalizedDiagnosticId;
      }
      messages = trimMessages([...messages, message]);
      await client.query(`
        UPDATE conversations
        SET diagnostic_id = $3, messages = $4::jsonb, touched_at = NOW()
        WHERE route = $1 AND id = $2
      `, [route, id, boundDiagnosticId, JSON.stringify(messages)]);
      await client.query('COMMIT');
      return { ok: true, conversation: { diagnosticId: boundDiagnosticId, messages } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export async function appendConversationMessage({ route, id, message, db, now = Date.now() }) {
  if (!db) {
    const conversation = localConversations.get(conversationKey(route, id));
    if (!conversation) return false;
    conversation.messages = trimMessages([...conversation.messages, message]);
    conversation.lastSeenAt = now;
    return true;
  }
  return withClient(db, async client => {
    await client.query('BEGIN');
    try {
      const selected = await client.query(`
        SELECT messages FROM conversations
        WHERE route = $1 AND id = $2
        FOR UPDATE
      `, [route, id]);
      if (!selected.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      const messages = trimMessages([...normalizeMessages(selected.rows[0].messages), message]);
      await client.query(`
        UPDATE conversations SET messages = $3::jsonb, touched_at = NOW()
        WHERE route = $1 AND id = $2
      `, [route, id, JSON.stringify(messages)]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export async function consumeFixedWindow({ scope, key, limit, windowMs, db, now = Date.now() }) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  if (!db) {
    for (const [entryKey, value] of localWindows) {
      if (value.resetAt <= now) localWindows.delete(entryKey);
    }
    const entryKey = `${scope}:${key}:${windowStart}`;
    if (!localWindows.has(entryKey) && localWindows.size >= LOCAL_LIMIT_MAX) {
      return { allowed: false, remaining: 0, resetAt };
    }
    const count = (localWindows.get(entryKey)?.count || 0) + 1;
    localWindows.set(entryKey, { count, resetAt });
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
  }

  const result = await db.query(`
    WITH cleaned AS (
      DELETE FROM rate_limit_windows WHERE expires_at <= NOW()
    ), consumed AS (
      INSERT INTO rate_limit_windows (scope, key, window_start, count, expires_at)
      VALUES ($1, $2, $3, 1, to_timestamp($4 / 1000.0))
      ON CONFLICT (scope, key, window_start) DO UPDATE
      SET count = rate_limit_windows.count + 1
      RETURNING count
    )
    SELECT count FROM consumed
  `, [scope, key, windowStart, resetAt]);
  const count = Number(result.rows[0]?.count || limit + 1);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
}

function pruneLocalLeases(scope, now) {
  for (const [key, lease] of localLeases) {
    if (lease.scope === scope && lease.expiresAt <= now) localLeases.delete(key);
  }
}

export async function acquireConcurrencyLease({ scope, limit, ttlMs, db, now = Date.now(), leaseId = crypto.randomUUID() }) {
  if (!db) {
    pruneLocalLeases(scope, now);
    const active = [...localLeases.values()].filter(lease => lease.scope === scope).length;
    if (active >= limit) return { allowed: false };
    localLeases.set(leaseId, { scope, expiresAt: now + ttlMs });
    let released = false;
    return {
      allowed: true,
      leaseId,
      async release() {
        if (released) return;
        localLeases.delete(leaseId);
        released = true;
      },
    };
  }

  const allowed = await withClient(db, async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scope]);
      await client.query('DELETE FROM concurrency_leases WHERE expires_at <= NOW()');
      const active = await client.query('SELECT COUNT(*)::integer AS count FROM concurrency_leases WHERE scope = $1', [scope]);
      if (Number(active.rows[0]?.count || 0) >= limit) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(`
        INSERT INTO concurrency_leases (scope, lease_id, expires_at)
        VALUES ($1, $2, to_timestamp($3 / 1000.0))
      `, [scope, leaseId, now + ttlMs]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
  if (!allowed) return { allowed: false };
  let released = false;
  return {
    allowed: true,
    leaseId,
    async release() {
      if (released) return;
      await db.query('DELETE FROM concurrency_leases WHERE scope = $1 AND lease_id = $2', [scope, leaseId]);
      released = true;
    },
  };
}
