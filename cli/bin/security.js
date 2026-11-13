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

// OpenClaw stamps meta.lastTouchedVersion with the version of the binary that
// wrote the config (openclaw/openclaw src/config/io.meta.ts). Releases are
// YYYY.M.P, optional -alpha.N/-beta.N prereleases, or a numeric correction,
// ordered the way src/config/version.ts and src/infra/semver.ts compare them.
// `openclaw --version` prints `OpenClaw <version>` or `OpenClaw <version> (<commit>)`
// (src/cli/program/help.ts). Only the version token is kept.
// Duplicated in cli/core/diagnostics.js. The production image ships this file
// and does not copy cli/core. Keep the two copies in sync.
const OPENCLAW_VERSION_LIMIT = 64;
const LEGACY_DOT_BETA_VERSION = /^([vV]?[0-9]+\.[0-9]+\.[0-9]+)\.beta(?:\.([0-9A-Za-z.-]+))?$/;
const OPENCLAW_RELEASE_VERSION = /^(?:[vV])?(\d{4})\.(\d{1,2})\.(\d+)(?:-(alpha|beta)\.(\d+)|-(\d+))?$/;
const PRINTED_OPENCLAW_VERSION = /^OpenClaw\s+(\S+?)(?:\s+\([^)\s]+\))?$/;
const OPENCLAW_CHANNEL_RANK = { prerelease: 0, stable: 1, correction: 2 };
const OPENCLAW_PRERELEASE_RANK = { alpha: 0, beta: 1 };

function normalizeLegacyDotBetaVersion(version) {
  const match = LEGACY_DOT_BETA_VERSION.exec(version);
  if (!match) return version;
  return match[2] ? `${match[1]}-beta.${match[2]}` : `${match[1]}-beta`;
}

function openClawDecimal(text) {
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function parseOpenClawRelease(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > OPENCLAW_VERSION_LIMIT || trimmed.includes('+')) return null;
  const normalized = normalizeLegacyDotBetaVersion(trimmed);
  if (normalized.length > OPENCLAW_VERSION_LIMIT || normalized.includes('+')) return null;
  const match = OPENCLAW_RELEASE_VERSION.exec(normalized);
  if (!match) return null;
  const major = openClawDecimal(match[1]);
  const minor = openClawDecimal(match[2]);
  const patch = openClawDecimal(match[3]);
  if (major === null || minor === null || patch === null) return null;
  if (minor < 1 || minor > 12 || patch < 1) return null;
  const label = match[4];
  if (label) {
    const seq = openClawDecimal(match[5]);
    if (seq === null || seq < 1) return null;
    return {
      major,
      minor,
      patch,
      channel: 'prerelease',
      label,
      seq,
      text: `${major}.${minor}.${patch}-${label}.${seq}`,
    };
  }
  if (match[6]) {
    const seq = openClawDecimal(match[6]);
    if (seq === null || seq < 1) return null;
    return {
      major,
      minor,
      patch,
      channel: 'correction',
      label: null,
      seq,
      text: `${major}.${minor}.${patch}-${seq}`,
    };
  }
  return {
    major,
    minor,
    patch,
    channel: 'stable',
    label: null,
    seq: null,
    text: `${major}.${minor}.${patch}`,
  };
}

function compareParsedOpenClawVersions(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.channel !== right.channel) {
    return OPENCLAW_CHANNEL_RANK[left.channel] < OPENCLAW_CHANNEL_RANK[right.channel] ? -1 : 1;
  }
  if (left.channel === 'prerelease') {
    if (left.label !== right.label) {
      return OPENCLAW_PRERELEASE_RANK[left.label] < OPENCLAW_PRERELEASE_RANK[right.label] ? -1 : 1;
    }
    if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
  } else if (left.channel === 'correction' && left.seq !== right.seq) {
    return left.seq < right.seq ? -1 : 1;
  }
  return 0;
}

export function parseStoredOpenClawVersion(value) {
  return parseOpenClawRelease(value)?.text ?? null;
}

export function parsePrintedOpenClawVersion(value) {
  if (typeof value !== 'string') return null;
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) return null;
  const stored = parseOpenClawRelease(line);
  if (stored) return stored.text;
  const printed = PRINTED_OPENCLAW_VERSION.exec(line);
  if (!printed) return null;
  return parseOpenClawRelease(printed[1])?.text ?? null;
}

export function compareOpenClawVersions(left, right) {
  const parsedLeft = parseOpenClawRelease(left);
  const parsedRight = parseOpenClawRelease(right);
  if (!parsedLeft || !parsedRight) return null;
  return compareParsedOpenClawVersions(parsedLeft, parsedRight);
}

export function configWrittenByNewerVersion(diagnostic) {
  const openclaw = diagnostic?.openclaw;
  const cliVersion = parseStoredOpenClawVersion(openclaw?.cliVersion)
    ?? parsePrintedOpenClawVersion(openclaw?.version);
  const configVersion = parseStoredOpenClawVersion(openclaw?.configLastTouchedVersion)
    ?? parseStoredOpenClawVersion(diagnostic?.config?.meta?.lastTouchedVersion);
  if (!cliVersion || !configVersion) return null;
  const comparison = compareOpenClawVersions(cliVersion, configVersion);
  if (comparison === null || comparison >= 0) return null;
  return { cliVersion, configVersion };
}

export function describeConfigWrittenByNewerVersion(versions) {
  const cliVersion = versions?.cliVersion;
  const configVersion = versions?.configVersion;
  if (parseStoredOpenClawVersion(cliVersion) !== cliVersion) return null;
  if (parseStoredOpenClawVersion(configVersion) !== configVersion) return null;
  return `OpenClaw config was written by ${configVersion}, which is newer than the installed CLI ${cliVersion}. An older CLI can misread or rewrite newer config. Upgrade the CLI to at least ${configVersion}, check which -a openclaw for a shadowing older install, or restore a matching backup. No config is written.`;
}

// A global npm install lives at {prefix}/lib/node_modules/openclaw and its bin
// is {prefix}/bin/openclaw -> openclaw.mjs (package.json "bin" / "files").
// The launcher then loads dist/entry.js or dist/entry.mjs. pnpm, yarn, bun,
// source checkouts (.git, src/entry.ts, pnpm-lock.yaml), and any other layout
// are not this install. Duplicated in cli/core/diagnostics.js. The production
// image ships this file and does not copy cli/core. Keep the two copies in sync.
const NPM_INSTALL_MISSING = [
  ['packageJson', false, 'package.json'],
  ['binTarget', false, 'bin target'],
  ['distEntry', false, 'dist entry'],
  ['pluginPathMissing', true, 'bundled plugin path'],
  ['lifecycleIncomplete', true, 'package lifecycle'],
];
const NPM_INSTALL_ROOT = /^~?(?:\/[A-Za-z0-9._@+-]+)+$/;

function sanitizeNpmPackageRoot(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text || text.length > 240) return null;
  text = text.replace(/^\/(?:home|Users)\/[^/]+/, '~');
  if (!NPM_INSTALL_ROOT.test(text)) return null;
  const segments = text.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  if (!text.endsWith('/lib/node_modules/openclaw')) return null;
  return text;
}

export function incompleteNpmInstall(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.manager !== 'npm') return null;
  const missing = [];
  for (const [key, expected, label] of NPM_INSTALL_MISSING) {
    if (record[key] === expected) missing.push(label);
  }
  if (missing.length === 0) return null;
  return {
    missing,
    packageRoot: sanitizeNpmPackageRoot(record.packageRoot),
    version: parseStoredOpenClawVersion(record.version),
  };
}

export function describeIncompleteNpmInstall(detail) {
  const allowed = new Set(NPM_INSTALL_MISSING.map(([, , label]) => label));
  const missing = Array.isArray(detail?.missing)
    ? detail.missing.filter(label => allowed.has(label))
    : [];
  if (missing.length === 0) return null;
  const packageRoot = sanitizeNpmPackageRoot(detail?.packageRoot);
  const version = parseStoredOpenClawVersion(detail?.version);
  const where = packageRoot ? ` at ${packageRoot}` : '';
  const reinstall = version
    ? `npm install -g openclaw@${version}`
    : 'npm install -g openclaw@<installed version>';
  return `A global npm install of OpenClaw${where} is incomplete (${missing.join(', ')}). Reinstall with ${reinstall}, or run openclaw update. Config and state are left unchanged.`;
}

// `openclaw update status --json` writes update, channel, and availability
// (openclaw/openclaw src/cli/update-cli/status.ts). The running version is not
// in that object; it is the CLI version `openclaw --version` already printed.
// availability.latestVersion is set only when the registry copy for the
// configured channel is newer (src/commands/status.update.ts). Beta may follow
// the newer of the beta tag and npm latest (src/infra/update-channels.ts).
// Dev, git/source, host, and immutable installs are not package-channel advice.
// Duplicated in cli/core/diagnostics.js. The production image ships this file
// and does not copy cli/core. Keep the two copies in sync.
const UPDATE_PACKAGE_CHANNELS = new Set(['stable', 'beta', 'extended-stable']);

function isUpdateRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function releaseFitsUpdateChannel(channel, version, tag) {
  const parsed = parseOpenClawRelease(version);
  if (!parsed || parsed.text !== version) return false;
  const prerelease = parsed.channel === 'prerelease';
  if (channel === 'stable') {
    return (tag == null || tag === 'latest') && !prerelease && parsed.patch < 33;
  }
  if (channel === 'extended-stable') {
    return tag === 'extended-stable' && !prerelease && parsed.patch >= 33;
  }
  if (channel !== 'beta' || tag == null || (parsed.patch >= 33 && !prerelease)) return false;
  if (tag === 'latest') return !prerelease;
  return tag === 'beta';
}

export function projectOpenClawUpdateStatus(parsed, currentVersion) {
  if (!isUpdateRecord(parsed)) return null;
  const update = parsed.update;
  const channelInfo = parsed.channel;
  const availability = parsed.availability;
  if (!isUpdateRecord(update) || !isUpdateRecord(channelInfo) || !isUpdateRecord(availability)) {
    return null;
  }
  if (update.error || update.installKind !== 'package') return null;
  const registry = update.registry;
  if (!isUpdateRecord(registry) || registry.error || registry.reason) return null;
  const channel = channelInfo.value;
  if (!UPDATE_PACKAGE_CHANNELS.has(channel)) return null;
  if (channelInfo.config != null && channelInfo.config !== channel) return null;
  const tag = registry.tag == null ? null : registry.tag;
  if (tag != null && typeof tag !== 'string') return null;
  const current = parseStoredOpenClawVersion(currentVersion)
    ?? parsePrintedOpenClawVersion(currentVersion);
  if (!current) return null;
  const reportedAvailable = availability.available === true
    && availability.hasRegistryUpdate === true
    && availability.hasGitUpdate !== true;
  if (availability.available !== true && availability.available !== false) return null;
  const rawAvailable = reportedAvailable ? availability.latestVersion : registry.latestVersion;
  const available = parseStoredOpenClawVersion(rawAvailable);
  if (!available || !releaseFitsUpdateChannel(channel, available, tag)) return null;
  const comparison = compareOpenClawVersions(current, available);
  if (comparison === null) return null;
  if (reportedAvailable) {
    if (comparison >= 0) return null;
    if (parseStoredOpenClawVersion(availability.latestVersion) !== available) return null;
  } else if (comparison < 0) {
    return null;
  }
  return {
    currentVersion: current,
    availableVersion: available,
    channel,
    updateAvailable: reportedAvailable,
  };
}

export function openclawUpdateAvailable(record) {
  if (!isUpdateRecord(record) || record.updateAvailable !== true) return null;
  const channel = record.channel;
  if (!UPDATE_PACKAGE_CHANNELS.has(channel)) return null;
  const currentVersion = parseStoredOpenClawVersion(record.currentVersion);
  const availableVersion = parseStoredOpenClawVersion(record.availableVersion);
  if (!currentVersion || !availableVersion) return null;
  if (!releaseFitsUpdateChannel(channel, availableVersion, channel === 'stable' ? 'latest' : channel)) {
    return null;
  }
  const comparison = compareOpenClawVersions(currentVersion, availableVersion);
  if (comparison === null || comparison >= 0) return null;
  return { currentVersion, availableVersion, channel };
}

export function describeOpenClawUpdateAvailable(detail) {
  const currentVersion = detail?.currentVersion;
  const availableVersion = detail?.availableVersion;
  const channel = detail?.channel;
  if (parseStoredOpenClawVersion(currentVersion) !== currentVersion) return null;
  if (parseStoredOpenClawVersion(availableVersion) !== availableVersion) return null;
  if (!UPDATE_PACKAGE_CHANNELS.has(channel)) return null;
  return `OpenClaw ${currentVersion} has ${availableVersion} available on the ${channel} channel. Run openclaw update. ClawFix does not apply the update.`;
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
