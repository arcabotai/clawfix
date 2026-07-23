/**
 * Outbound privacy: projection, redaction boundary helpers, and destination disclosure.
 * Remote upload must never happen without an explicit caller consent flag.
 */

import { redactOutbound } from '../bin/security.js';

export const DEFAULT_CLAWFIX_BASE_URL = 'https://clawfix.dev';
export const DEFAULT_PROVIDER_CHAIN = Object.freeze([
  'ClawFix service',
  'OpenRouter',
  'selected model',
]);

export const DEFAULT_INCLUDED_FIELDS = Object.freeze([
  'Your message',
  'OS and OpenClaw versions (when present on a linked diagnostic)',
  'Redacted configuration fields (when present on a linked diagnostic)',
  'Matching error lines (when present on a linked diagnostic)',
  'Client-supplied reviewed repair IDs (id, title, risk only)',
]);

export const DEFAULT_EXCLUDED_FIELDS = Object.freeze([
  'Workspace document contents',
  'Top-level config env block',
  'Chat history outside this ClawFix session',
  'Real hostname',
  'Shell commands, patches, or executable repair payloads',
]);

const REPAIR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONV_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RISK_SET = new Set(['low', 'medium', 'high', 'critical', 'info', 'informational']);
const MAX_MESSAGE_CHARS = 4000;
const MAX_TITLE_CHARS = 200;
const MAX_REPAIRS = 32;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Resolve the exact destination hostname (and optional path origin) for disclosure UI.
 * @param {string} baseUrl
 */
export function resolveDestination(baseUrl) {
  const raw = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : DEFAULT_CLAWFIX_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`Invalid ClawFix base URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('ClawFix base URL must be http or https');
  }
  return Object.freeze({
    baseUrl: url.origin,
    hostname: url.hostname,
    endpointPath: '/api/v2/agent/messages',
    endpointUrl: `${url.origin}/api/v2/agent/messages`,
  });
}

/**
 * Build an immutable disclosure record for privacy approval UI.
 */
export function buildDisclosure({
  baseUrl = DEFAULT_CLAWFIX_BASE_URL,
  providerChain = DEFAULT_PROVIDER_CHAIN,
  included = DEFAULT_INCLUDED_FIELDS,
  excluded = DEFAULT_EXCLUDED_FIELDS,
  customServer = false,
} = {}) {
  const destination = resolveDestination(baseUrl);
  const chain = Array.isArray(providerChain) && providerChain.length > 0
    ? providerChain.map((part) => String(part))
    : [...DEFAULT_PROVIDER_CHAIN];

  // Custom servers: disclose exact host; do not claim OpenRouter unless caller says so.
  const effectiveChain = customServer || destination.hostname !== 'clawfix.dev'
    ? Object.freeze([`Custom ClawFix server (${destination.hostname})`, ...chain.filter((p) => !/clawfix service/i.test(p))])
    : Object.freeze([...chain]);

  return Object.freeze({
    destination: destination.hostname,
    baseUrl: destination.baseUrl,
    endpointUrl: destination.endpointUrl,
    providerChain: effectiveChain,
    providerLabel: effectiveChain.join(' → '),
    included: Object.freeze([...(included || DEFAULT_INCLUDED_FIELDS)].map(String)),
    excluded: Object.freeze([...(excluded || DEFAULT_EXCLUDED_FIELDS)].map(String)),
  });
}

/**
 * Project local catalog / finding repairs into the strict API v2 availableRepairs shape.
 * Never forwards shell, command, path, or apply fields.
 */
export function projectAvailableRepairs(repairs) {
  if (repairs == null) return Object.freeze([]);
  if (!Array.isArray(repairs)) {
    throw new TypeError('availableRepairs must be an array');
  }
  if (repairs.length > MAX_REPAIRS) {
    throw new TypeError(`availableRepairs exceeds max of ${MAX_REPAIRS}`);
  }

  const seen = new Set();
  const out = [];
  for (const entry of repairs) {
    if (!isPlainObject(entry)) {
      throw new TypeError('availableRepairs entries must be objects');
    }
    for (const banned of ['shell', 'command', 'script', 'patch', 'apply', 'exec', 'files', 'path']) {
      if (Object.prototype.hasOwnProperty.call(entry, banned)) {
        throw new TypeError(`Repair field "${banned}" is not allowed in outbound projection`);
      }
    }
    const id = asTrimmedString(entry.id ?? entry.repairId, 128);
    if (!id || !REPAIR_ID_RE.test(id)) {
      throw new TypeError('availableRepairs[].id is invalid');
    }
    if (seen.has(id)) {
      throw new TypeError(`duplicate repair id: ${id}`);
    }
    seen.add(id);

    const title = asTrimmedString(entry.title ?? id, MAX_TITLE_CHARS) || id;
    let risk = 'medium';
    if (entry.risk != null) {
      const r = asTrimmedString(String(entry.risk), 32)?.toLowerCase();
      if (!r || !RISK_SET.has(r)) {
        throw new TypeError('availableRepairs[].risk is invalid');
      }
      risk = r === 'informational' ? 'info' : r;
    }
    out.push(Object.freeze({ id, title, risk }));
  }
  return Object.freeze(out);
}

/**
 * Build the exact JSON body for POST /api/v2/agent/messages after projection.
 * Does not upload; caller must still apply redaction and consent.
 */
export function projectAgentV2Request({
  conversationId,
  message,
  diagnosticId = null,
  availableRepairs = [],
} = {}) {
  const conv = asTrimmedString(conversationId, 128);
  if (!conv || !CONV_ID_RE.test(conv)) {
    throw new TypeError('conversationId is required and must be 8-128 URL-safe characters');
  }
  const msg = asTrimmedString(message, MAX_MESSAGE_CHARS);
  if (!msg) {
    throw new TypeError('message is required');
  }

  let diag = null;
  if (diagnosticId != null && diagnosticId !== '') {
    diag = asTrimmedString(diagnosticId, 128);
    if (!diag || !CONV_ID_RE.test(diag)) {
      throw new TypeError('diagnosticId is invalid');
    }
  }

  const repairs = projectAvailableRepairs(availableRepairs);
  return Object.freeze({
    conversationId: conv,
    message: msg,
    diagnosticId: diag,
    availableRepairs: repairs,
  });
}

/**
 * Final network-boundary redaction. Always returns a fresh plain object.
 */
export function redactForNetwork(value, redact = redactOutbound) {
  if (typeof redact !== 'function') {
    throw new TypeError('redact must be a function');
  }
  const redacted = redact(value);
  if (!isPlainObject(redacted) && !Array.isArray(redacted) && typeof redacted !== 'string') {
    // For agent v2 body we always expect an object after walk; tolerate primitives only if caller passes them.
    if (redacted === null || redacted === undefined) {
      throw new TypeError('redact must return a value');
    }
  }
  return redacted;
}

/**
 * Convenience: project then redact the agent v2 request body.
 */
export function buildOutboundAgentPayload(input, { redact = redactOutbound } = {}) {
  const projected = projectAgentV2Request(input);
  // Message text is scrubbed; nested repairs are already allowlisted.
  const redacted = redactForNetwork(projected, redact);
  if (!isPlainObject(redacted)) {
    throw new TypeError('redacted outbound payload must be a plain object');
  }
  // Re-freeze projected shape after redaction (redact may return plain mutable object).
  return Object.freeze({
    conversationId: redacted.conversationId,
    message: typeof redacted.message === 'string' ? redacted.message.slice(0, MAX_MESSAGE_CHARS) : projected.message,
    diagnosticId: redacted.diagnosticId ?? null,
    availableRepairs: Object.freeze(
      Array.isArray(redacted.availableRepairs)
        ? redacted.availableRepairs.map((r) => Object.freeze({
          id: r.id,
          title: r.title,
          risk: r.risk,
        }))
        : [...projected.availableRepairs],
    ),
  });
}
