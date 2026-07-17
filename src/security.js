import { timingSafeEqual } from 'node:crypto';

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

export function isPaidAIEnabled(config, env = process.env) {
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

export const sharedAIRequestGuard = createAIRequestGuard({
  token: process.env.CLAWFIX_API_TOKEN || '',
  dailyLimit: positiveEnvInteger(process.env.AI_DAILY_REQUEST_LIMIT, 200),
  concurrency: positiveEnvInteger(process.env.AI_MAX_CONCURRENCY, 4),
});
