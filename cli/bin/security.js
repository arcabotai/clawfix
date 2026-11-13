import { homedir } from 'node:os';

export const FIX_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const REDACTED = '***REDACTED***';
// Kept in sync with cli/core/diagnostics.js. The production image ships this
// file and does not copy cli/core, so the server must not import the core copy.
export const OPENCLAW_REDACTED_PLACEHOLDER = '__OPENCLAW_REDACTED__';
const PLACEHOLDER_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const PLACEHOLDER_PATH_LIMIT = 32;
const PLACEHOLDER_PATH_DEPTH = 24;
const PLACEHOLDER_PATH_LENGTH = 512;
const REPORTED_PLACEHOLDER_PATH = /^(?:[A-Za-z0-9_-]{1,128})(?:\.[A-Za-z0-9_-]{1,128}){0,23}$/;
const SENSITIVE_KEY = /(?:^|_)(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|jwt|password|private[_-]?key|secret|session[_-]?token|token)(?:$|_)/i;
const ISSUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function normalizeKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

function isSensitiveKey(value) {
  return SENSITIVE_KEY.test(normalizeKey(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(value, { home = homedir() } = {}) {
  let text = String(value ?? '');
  text = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, REDACTED)
    .replace(/((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi, `$1${REDACTED}`)
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}\b/gi, `$1${REDACTED}`)
    .replace(/\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1${REDACTED}:${REDACTED}@`)
    .replace(/\b(?:sk(?:-or-v\d+)?[-_]|xai[-_]|gh[pousr]_|npm_|m0[-_]|ntn_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/gi, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/((?:^|[\s;])(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=\s*)(?:(['"])[\s\S]*?\2|[^\s;]+)/gim, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|access[_-]?token|cookie|credential|jwt|password|secret|token)\s*[=:]\s*)(?:(['"])[\s\S]*?\2|[^\s,;]+)/gi, `$1${REDACTED}`);

  if (home && home !== '/') {
    text = text.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  }
  return text;
}

export function isOpenClawRedactedPlaceholder(value) {
  return typeof value === 'string' && value.trim() === OPENCLAW_REDACTED_PLACEHOLDER;
}

function placeholderChildPath(path, segment) {
  const depth = path ? path.split('.').length : 0;
  if (depth >= PLACEHOLDER_PATH_DEPTH) return null;
  const next = path ? `${path}.${segment}` : segment;
  if (next.length > PLACEHOLDER_PATH_LENGTH) return null;
  return next;
}

export function collectOpenClawRedactedPlaceholderPaths(value) {
  const paths = [];
  const seen = new WeakSet();
  const visit = (node, path) => {
    if (paths.length >= PLACEHOLDER_PATH_LIMIT) return;
    if (typeof node === 'string') {
      if (path && isOpenClawRedactedPlaceholder(node)) paths.push(path);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (paths.length >= PLACEHOLDER_PATH_LIMIT) return;
        const segment = String(index);
        if (!PLACEHOLDER_PATH_SEGMENT.test(segment)) continue;
        const next = placeholderChildPath(path, segment);
        if (next) visit(node[index], next);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (paths.length >= PLACEHOLDER_PATH_LIMIT) return;
      if (!PLACEHOLDER_PATH_SEGMENT.test(key)) continue;
      const next = placeholderChildPath(path, key);
      if (next) visit(child, next);
    }
  };
  visit(value, '');
  return paths;
}

export function placeholderPathsForDiagnostic(diagnostic) {
  const fromConfig = collectOpenClawRedactedPlaceholderPaths(diagnostic?.config);
  const reported = diagnostic?.openclaw?.redactedPlaceholderPaths;
  if (!Array.isArray(reported)) return fromConfig;
  const seen = new Set(fromConfig);
  const merged = fromConfig.slice(0, PLACEHOLDER_PATH_LIMIT);
  for (const path of reported) {
    if (merged.length >= PLACEHOLDER_PATH_LIMIT) break;
    if (typeof path !== 'string' || !REPORTED_PLACEHOLDER_PATH.test(path) || seen.has(path)) continue;
    seen.add(path);
    merged.push(path);
  }
  return merged;
}

export function describeOpenClawRedactedPlaceholders(paths) {
  const list = Array.isArray(paths)
    ? paths.filter(path => typeof path === 'string' && REPORTED_PLACEHOLDER_PATH.test(path))
    : [];
  const shown = list.slice(0, PLACEHOLDER_PATH_LIMIT);
  const extra = list.length - shown.length;
  const where = shown.length > 0
    ? ` at ${shown.join(', ')}${extra > 0 ? `, and ${extra} more` : ''}`
    : '';
  return `OpenClaw config stores the ${OPENCLAW_REDACTED_PLACEHOLDER} placeholder${where}. Those stored values are not credentials. Re-enter each listed path with openclaw secrets or openclaw config set, and do not paste redacted config get output back into the file.`;
}

function redactSensitiveValue(value) {
  // Keep OpenClaw's public sentinel distinguishable from ClawFix's own marker.
  // A real credential on the same key is still replaced with REDACTED.
  if (isOpenClawRedactedPlaceholder(value)) return OPENCLAW_REDACTED_PLACEHOLDER;
  return REDACTED;
}

export function redactOutbound(value, options = {}) {
  const seen = new WeakSet();
  const walk = (item, key = '') => {
    if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') return item;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string') return isSensitiveKey(key) ? redactSensitiveValue(item) : redactText(item, options);
    if (typeof item !== 'object') return redactText(String(item), options);
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.map(entry => walk(entry));
    const result = {};
    for (const [childKey, childValue] of Object.entries(item)) {
      result[childKey] = isSensitiveKey(childKey) ? redactSensitiveValue(childValue) : walk(childValue, childKey);
    }
    return result;
  };
  return walk(value);
}

export function projectLocalIssuesForUpload(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 100).map(issue => {
    const projected = {
      severity: issue?.severity,
      kind: issue?.kind,
      text: issue?.text,
    };
    if (typeof issue?.knownIssueId === 'string' && ISSUE_ID_PATTERN.test(issue.knownIssueId)) {
      projected.knownIssueId = issue.knownIssueId;
    }
    if (typeof issue?.nativeCheckId === 'string' && ISSUE_ID_PATTERN.test(issue.nativeCheckId)) {
      projected.nativeCheckId = issue.nativeCheckId;
    }
    return projected;
  });
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
