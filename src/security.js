import { timingSafeEqual } from 'node:crypto';
import { getPool } from './db.js';
import { getRuntimeEnv } from './runtime-env.js';
import { acquireConcurrencyLease, consumeFixedWindow } from './shared-state.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

export function validateDiagnosticBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  if (!body.system || typeof body.system !== 'object' || Array.isArray(body.system)) return { ok: false };
  const os = body.system.os;
  if (typeof os !== 'string' || os.length < 1 || os.length > 100) return { ok: false };
  if (byteLength(JSON.stringify(body)) > 512_000) return { ok: false };
  if (byteLength(body.logs?.errors) > 100_000 || byteLength(body.logs?.stderr) > 100_000 || byteLength(body.logs?.gatewayLog) > 100_000) return { ok: false };
  if (Array.isArray(body._localIssues) && body._localIssues.length > 100) return { ok: false };
  return { ok: true };
}

export function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  if (typeof body.message !== 'string' || body.message.trim().length < 1 || byteLength(body.message) > 4_000) return { ok: false };
  if (typeof body.conversationId !== 'string' || !UUID_PATTERN.test(body.conversationId)) return { ok: false };
  if (body.diagnosticId != null && (typeof body.diagnosticId !== 'string' || !SHORT_ID_PATTERN.test(body.diagnosticId))) return { ok: false };
  return { ok: true };
}

export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10_000 } = {}) {
  const buckets = new Map();
  let nextSweepAt = 0;
  return {
    consume(key) {
      const time = now();
      if (time >= nextSweepAt) {
        for (const [entryKey, entry] of buckets) {
          if (time >= entry.resetAt) buckets.delete(entryKey);
        }
        nextSweepAt = time + windowMs;
      }
      let bucket = buckets.get(key);
      if (!bucket && buckets.size >= maxKeys) {
        return { allowed: false, remaining: 0, resetAt: nextSweepAt };
      }
      if (!bucket || time >= bucket.resetAt) bucket = { count: 0, resetAt: time + windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
      return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
    },
  };
}

export function createConcurrencyGate(limit) {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active -= 1;
        }
      };
    },
    get active() { return active; },
  };
}

export function positiveEnvInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isPaidAIEnabled(config, env = getRuntimeEnv()) {
  if (!config?.apiKey) return false;
  return Boolean(env.CLAWFIX_API_TOKEN) || env.ALLOW_PUBLIC_AI === '1';
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function bearerToken(req) {
  const value = req?.headers?.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}

function tokensEqual(expected, received) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(received));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Recognize an operational canary without turning its marker into an auth bypass.
 * Missing configuration, non-string headers, and any mismatch all fail closed.
 */
export function isAuthorizedCanaryRequest(req, env = getRuntimeEnv()) {
  const expected = env?.CLAWFIX_CANARY_TOKEN;
  const received = req?.headers?.['x-clawfix-canary'];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof received !== 'string' || received.length === 0) return false;
  return tokensEqual(expected, received);
}

export function createAIRequestGuard({
  token = '',
  dailyLimit = 200,
  concurrency = 4,
  now = Date.now,
} = {}) {
  const budget = createRateLimiter({ limit: dailyLimit, windowMs: 86_400_000, now });
  const gate = createConcurrencyGate(concurrency);
  return {
    acquire(req) {
      if (token && !tokensEqual(token, bearerToken(req))) {
        return { allowed: false, status: 401, error: 'Unauthorized' };
      }
      const release = gate.tryAcquire();
      if (!release) return { allowed: false, status: 503, error: 'AI service is busy' };
      if (!budget.consume('global').allowed) {
        release();
        return { allowed: false, status: 429, error: 'Daily AI request budget exhausted' };
      }
      return { allowed: true, release };
    },
  };
}

export async function consumeRouteRateLimit(scope, req, {
  env = getRuntimeEnv(),
  db = getPool(),
  limit = positiveEnvInteger(env.CHAT_RATE_LIMIT, 30),
  windowMs = positiveEnvInteger(env.RATE_LIMIT_WINDOW_MS, 60_000),
} = {}) {
  return consumeFixedWindow({ scope, key: clientIp(req), limit, windowMs, db });
}

export const sharedAIRequestGuard = {
  async acquire(req, { env = getRuntimeEnv(), db = getPool() } = {}) {
    const token = env.CLAWFIX_API_TOKEN || '';
    if (token && !tokensEqual(token, bearerToken(req))) {
      return { allowed: false, status: 401, error: 'Unauthorized' };
    }
    const lease = await acquireConcurrencyLease({
      scope: 'ai-global',
      limit: positiveEnvInteger(env.AI_MAX_CONCURRENCY, 4),
      ttlMs: Math.max(
        positiveEnvInteger(env.AI_LEASE_TTL_MS, 120_000),
        positiveEnvInteger(env.AI_TIMEOUT_MS, 90_000) + 30_000,
      ),
      db,
    });
    if (!lease.allowed) return { allowed: false, status: 503, error: 'AI service is busy' };
    let budget;
    try {
      budget = await consumeFixedWindow({
        scope: 'ai-daily',
        key: 'global',
        limit: positiveEnvInteger(env.AI_DAILY_REQUEST_LIMIT, 200),
        windowMs: 86_400_000,
        db,
      });
    } catch (error) {
      // Ownership is not transferred to the caller until the budget succeeds.
      // A failed budget query must not strand already-acquired concurrency.
      try {
        await lease.release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'AI budget and lease release failed');
      }
      throw error;
    }
    if (!budget.allowed) {
      await lease.release();
      return { allowed: false, status: 429, error: 'Daily AI request budget exhausted' };
    }
    return { allowed: true, release: lease.release };
  },
};
