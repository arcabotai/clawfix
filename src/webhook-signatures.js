/**
 * Webhook signature verification.
 *
 * Two rules this module exists to enforce:
 *
 *  1. Verify over the bytes the provider actually sent. `JSON.stringify(req.body)` is a
 *     different byte string than the request body — key order, spacing and unicode escaping
 *     all differ — so an HMAC over it cannot match the provider's signature.
 *  2. Fail closed. A webhook route that skips verification when no secret is configured is an
 *     unauthenticated endpoint wearing a signature check as decoration.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time compare of two strings, length-safe. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Lemon Squeezy: `X-Signature` is hex HMAC-SHA256 of the raw body under the webhook secret.
 * https://docs.lemonsqueezy.com/help/webhooks#signing-requests
 */
export function verifyLemonSqueezySignature({ secret, rawBody, signature }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { ok: false, reason: 'no_raw_body' };
  if (typeof signature !== 'string' || !signature) return { ok: false, reason: 'missing_signature' };

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(signature.trim(), expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Svix (used by Resend): `svix-signature` is a space-separated list of `v1,<base64>` values,
 * each an HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` keyed by the base64 secret that
 * follows the `whsec_` prefix. https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 * A timestamp tolerance bounds replay of a captured-but-valid delivery.
 */
export function verifySvixSignature({
  secret,
  rawBody,
  id,
  timestamp,
  signature,
  now = Date.now(),
  toleranceSeconds = 300,
}) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { ok: false, reason: 'no_raw_body' };
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(now / 1000 - sentAt) > toleranceSeconds) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return { ok: false, reason: 'bad_secret' };

  const signed = Buffer.concat([
    Buffer.from(`${id}.${sentAt}.`, 'utf8'),
    rawBody,
  ]);
  const expected = createHmac('sha256', key).update(signed).digest('base64');

  // The header may carry several versioned signatures; any v1 match is a pass.
  for (const part of String(signature).split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    if (safeEqual(value, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}
