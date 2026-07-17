import { homedir } from 'node:os';

export const FIX_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const REDACTED = '***REDACTED***';
const SENSITIVE_KEY = /(?:^|_)(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|jwt|password|private[_-]?key|secret|session[_-]?token|token)(?:$|_)/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(value, { home = homedir() } = {}) {
  let text = String(value ?? '');
  text = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, REDACTED)
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1${REDACTED}:${REDACTED}@`)
    .replace(/\b(?:sk(?:-or-v\d+)?[-_]|xai[-_]|gh[pousr]_|npm_|m0[-_]|ntn_)[A-Za-z0-9._-]{8,}\b/gi, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/((?:^|[\s;])(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=\s*)(?:(['"])[\s\S]*?\2|[^\s;]+)/gim, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|access[_-]?token|cookie|credential|jwt|password|secret|token)\s*[=:]\s*)(?:(['"])[\s\S]*?\2|[^\s,;]+)/gi, `$1${REDACTED}`);

  if (home && home !== '/') {
    text = text.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  }
  return text;
}

export function redactOutbound(value, options = {}) {
  const seen = new WeakSet();
  const walk = (item, key = '') => {
    if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') return item;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string') return SENSITIVE_KEY.test(key) ? REDACTED : redactText(item, options);
    if (typeof item !== 'object') return redactText(String(item), options);
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.map(entry => walk(entry));
    const result = {};
    for (const [childKey, childValue] of Object.entries(item)) {
      result[childKey] = SENSITIVE_KEY.test(childKey) ? REDACTED : walk(childValue, childKey);
    }
    return result;
  };
  return walk(value);
}

export function validateFixId(value) {
  return typeof value === 'string' && FIX_ID_PATTERN.test(value) ? value : null;
}

export function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
