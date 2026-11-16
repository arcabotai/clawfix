import { homedir } from 'node:os';

export const FIX_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const REDACTED = '***REDACTED***';
// Kept in sync with cli/core/diagnostics.js. The production image ships this
// file and does not copy cli/core, so the server must not import the core copy.
export const OPENCLAW_REDACTED_PLACEHOLDER = '__OPENCLAW_REDACTED__';
// An empty invalid session node with a still-running window is invisible to
// sessions list and to doctor --session-sqlite inspect.
// openclaw src/config/sessions/session-canonical-row.ts:48-53 returns no entry
// for entry_json '{}' and entry_valid -1 when the window id matches.
// src/config/sessions/session-entry-read.worker.ts:534-543 keeps that row as a
// placeholder instead of a deletable session. There is no documented repair.
export const STUCK_SESSION_WINDOW_SQL = `SELECT COUNT(*) AS count
  FROM session_windows AS window
  INNER JOIN session_nodes AS node ON node.session_key = window.session_key
  WHERE node.entry_json = '{}'
    AND node.entry_valid = -1
    AND node.current_session_id = window.session_id
    AND window.status = 'running'
    AND window.ended_at IS NULL`;

const STUCK_SESSION_AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function stuckSessionWindowCount(record) {
  const count = record?.count;
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

const STUCK_SESSION_DATABASE_LIMIT = 32;

function isSqliteExperimentalWarning(warning, type) {
  const message = typeof warning === 'string' ? warning : warning?.message;
  const name = typeof warning === 'string' ? type : warning?.name;
  return name === 'ExperimentalWarning'
    && typeof message === 'string'
    && message.includes('SQLite is an experimental feature');
}

// Node 22 prints this when node:sqlite loads. The filter covers only that
// import, then the previous emitWarning is restored so other warnings still print.
async function importNodeSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarning(warning, type, ...rest) {
    if (isSqliteExperimentalWarning(warning, type)) return undefined;
    return originalEmitWarning.call(this, warning, type, ...rest);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

let nodeSqlitePromise;

function loadNodeSqlite() {
  nodeSqlitePromise ??= importNodeSqlite();
  return nodeSqlitePromise;
}

async function listAgentDatabasePaths(openclawDir) {
  const { readdir, lstat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let entries;
  try {
    entries = await readdir(join(openclawDir, 'agents'), { withFileTypes: true });
  } catch {
    return [];
  }
  const databases = [];
  for (const entry of entries) {
    if (databases.length >= STUCK_SESSION_DATABASE_LIMIT) break;
    if (!entry.isDirectory() || !STUCK_SESSION_AGENT_ID.test(entry.name)) continue;
    const databasePath = join(openclawDir, 'agents', entry.name, 'agent', 'openclaw-agent.sqlite');
    let info;
    try {
      info = await lstat(databasePath);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    databases.push({ agentId: entry.name, databasePath });
  }
  return databases;
}

export async function collectStuckSessionWindows(openclawDir) {
  if (typeof openclawDir !== 'string' || openclawDir.length === 0) return null;
  const databases = await listAgentDatabasePaths(openclawDir);
  if (databases.length === 0) return { count: 0, agents: [] };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await loadNodeSqlite());
  } catch {
    return null;
  }
  let count = 0;
  const agents = [];
  for (const { agentId, databasePath } of databases) {
    try {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = database.prepare(STUCK_SESSION_WINDOW_SQL).get();
        const found = Number(row?.count ?? 0);
        if (Number.isSafeInteger(found) && found > 0) {
          count += found;
          if (agents.length < 8) agents.push(agentId);
        }
      } finally {
        database.close();
      }
    } catch {
      // A store this OpenClaw build cannot open is unknown, not evidence of a stuck window.
    }
  }
  return { count, agents };
}

// OpenClaw cron scratch refuses more than 256 KiB.
// openclaw src/cron/scratch-contract.ts:2 and assertCronJobScratchContent at :93-99.
// Doctor reads HEARTBEAT.md with that cap
// (src/commands/doctor-heartbeat-scratch-migration.ts:137-146).
// Template Add applies the same limit only while planning
// (src/templates/portable-automation.ts:63-64), after validate has already passed.
export const HEARTBEAT_SCRATCH_MAX_BYTES = 256 * 1024;

export function classifyHeartbeatScratchFile({ bytes, utf8 } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  if (bytes > HEARTBEAT_SCRATCH_MAX_BYTES) return 'too-large';
  if (utf8 === false) return 'invalid-utf8';
  return null;
}

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

// OpenClaw 2026.11.3 prints the service-manager line even when that line is not
// the health check. A gateway started by hand looks like:
//   Runtime: stopped (diagnostic only, not the check target)
//   Connectivity check: ok
//   Listening: 127.0.0.1:18789
// The connectivity check is the verdict. A diagnostic-only "stopped" is not.
export function readGatewayLiveness(status) {
  const probe = String(status || '')
    .split('\n')
    .filter((line) => !/diagnostic only, not the check target/i.test(line))
    .join('\n');
  const connectivity = /(?:connectivity|read) check:\s*(ok|failed|timed out)/i.exec(probe);
  if (connectivity) return connectivity[1].toLowerCase() === 'ok' ? 'up' : 'down';
  if (/running.*pid|state active|^listening:/im.test(probe)) return 'up';
  if (/not running|failed to start|\bstopped\b|\binactive\b/i.test(probe)) return 'down';
  if (/warning/i.test(probe)) return 'unknown';
  return 'down';
}

// Every doctor invocation ClawFix starts uses this budget. It matches OpenClaw's
// hosted diagnosis timeout (src/commands/doctor-process.ts). A hung doctor --fix
// has ignored SIGTERM, so the kill escalates to SIGKILL after the grace period.
export const DOCTOR_INVOCATION_TIMEOUT_MS = 120_000;
export const DOCTOR_KILL_GRACE_MS = 5_000;
export const DOCTOR_KILL_SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL']);
// Shorter than the 26, 50, and 79 minute stalls, and longer than a doctor run
// that finished in about four minutes on the same host.
export const STALE_DOCTOR_ELAPSED_SECONDS = 15 * 60;

const DIAGNOSTIC_LOG_LINE = /error|warn|fail|crash|EADDRINUSE|EACCES|Legacy workspace setup state requires migration|legacy workspace setup conflicts with canonical SQLite state|missing or drifted index idx_agent_session_nodes_active|Legacy session store requires migration|sessions\.json|Stopped the managed Gateway for Doctor repair|SQLite read-only snapshot|sqlite-source-revision|content-version|process census is incomplete|undergoing offline maintenance|Doctor interrupted by SIGTERM|CLI signal cleanup did not complete|Doctor complete|Gateway restarted and verified|invalid-config|Unrecognized key|HEARTBEAT\.md cannot be migrated|HEARTBEAT\.md was not migrated|symlink target escapes the agent workspace|heartbeat-migration|requires Node|detected Node|is unsupported|preflight-node-runtime|Active Gateway runtime|owns this state directory|owns state-lifecycle|GatewayLockError|OPENCLAW_STATE_LEASE_ABORTED|state ownership is no longer current|cannot verify Gateway ownership|gateway\.auth REMOVED|config reload: gateway\.auth\.mode|AUTH_PROFILE_MIGRATION_REQUIRED|requires legacy credential migration|without replaying credentials|withheld-cross-device|device token mismatch|stale device-token pattern/i;

export function retainDiagnosticLogLine(line) {
  return DIAGNOSTIC_LOG_LINE.test(String(line ?? ''));
}

function uniqueShapes(shapes) {
  return Object.freeze([...new Set(shapes)]);
}

/**
 * Post-upgrade startup refusals that a gateway restart does not clear.
 * Shapes are the strings from openclaw/openclaw #137866, #150797, and #134873.
 */
export function classifyPostUpgradeMigration(text) {
  const source = String(text ?? '');
  const shapes = [];
  if (/Legacy workspace setup state requires migration/i.test(source)
      || /legacy workspace setup conflicts with canonical SQLite state/i.test(source)) {
    shapes.push('workspace-setup');
  }
  if (/missing or drifted index idx_agent_session_nodes_active/i.test(source)) {
    shapes.push('session-index');
  }
  if (/Legacy session store requires migration/i.test(source) && /sessions\.json\b/i.test(source)) {
    shapes.push('legacy-sessions');
  }
  if (shapes.length === 0) return null;
  return Object.freeze({ shapes: uniqueShapes(shapes), restartWillNotFix: true });
}

export function describePostUpgradeMigration(match) {
  const shapes = Array.isArray(match?.shapes) ? match.shapes : [];
  const parts = [
    'Post-upgrade state is crash-looping. openclaw gateway restart will not migrate it.',
  ];
  if (shapes.includes('workspace-setup')) {
    parts.push('Legacy workspace setup state requires migration. doctor --fix can refuse when that file conflicts with canonical SQLite state. Back up the state directory and move the legacy workspace setup file aside. Do not delete the workspace.');
  }
  if (shapes.includes('session-index')) {
    parts.push('The agent database is missing or has drifted index idx_agent_session_nodes_active. The reported repair was openclaw doctor --fix, which rebuilt the canonical index. Back up the state directory first. ClawFix does not run that command, because the same --fix stops the gateway and can hang.');
  }
  if (shapes.includes('legacy-sessions')) {
    parts.push('A legacy sessions.json still needs migration. On the reported 2026.8.1 release, doctor --fix skipped per-agent stores. The import that worked was openclaw doctor --session-sqlite import --session-sqlite-all-agents after stopping the gateway.');
  }
  parts.push('Do not automatically retry an unbounded doctor --fix.');
  return parts.join(' ');
}

function normalizeDoctorProcesses(value) {
  if (!Array.isArray(value)) return [];
  const processes = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const elapsedSeconds = entry.elapsedSeconds;
    if (!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0) continue;
    processes.push({ elapsedSeconds, fix: entry.fix === true });
    if (processes.length >= 8) break;
  }
  return processes;
}

function parseElapsedToken(value) {
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const parts = String(value).split(/[-:]/).map(part => Number(part));
  if (parts.length < 2 || parts.length > 4 || parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    return null;
  }
  const weights = parts.length === 2
    ? [60, 1]
    : parts.length === 3
      ? [3600, 60, 1]
      : [86400, 3600, 60, 1];
  return parts.reduce((total, part, index) => total + part * weights[index], 0);
}

/** Keep elapsed time and whether argv contained --fix. Drop the command text. */
export function projectDoctorProcesses(listing, { selfPid = '', parentPid = '' } = {}) {
  const processes = [];
  const skip = new Set([String(selfPid || ''), String(parentPid || '')].filter(Boolean));
  for (const line of String(listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, elapsedText, command] = match;
    if (skip.has(pid)) continue;
    if (!/(^|\s)openclaw(\s|$)/.test(command) || !/(^|\s)doctor(\s|$)/.test(command)) continue;
    if (/\bclawfix\b/.test(command)) continue;
    const elapsedSeconds = parseElapsedToken(elapsedText);
    if (elapsedSeconds === null) continue;
    processes.push({
      elapsedSeconds,
      fix: /(^|\s)--fix(\s|$)/.test(command),
    });
    if (processes.length >= 8) break;
  }
  return processes;
}

/**
 * Hung or failed doctor --fix. Log shapes are from openclaw/openclaw #191601,
 * #174842, and #170773. A completed doctor that only stopped and restarted the
 * gateway is not a stall.
 */
export function classifyStalledDoctor({ text = '', gatewayDown = false, doctorProcesses = [] } = {}) {
  const source = String(text ?? '');
  const processes = normalizeDoctorProcesses(doctorProcesses);
  const shapes = [];
  const snapshotCount = source.match(/SQLite read-only snapshot/gi)?.length ?? 0;
  if (snapshotCount >= 3) shapes.push('snapshot-loop');
  if (/sqlite-source-revision\.worker\.js/i.test(source) && /content-version/i.test(source)) {
    shapes.push('content-version-respawn');
  }
  if (/OpenClaw process census is incomplete/i.test(source)) shapes.push('census-stall');
  if (/Doctor interrupted by SIGTERM/i.test(source) || /CLI signal cleanup did not complete/i.test(source)) {
    shapes.push('sigterm-cleanup-failed');
  }
  if (processes.some(entry => entry.elapsedSeconds >= STALE_DOCTOR_ELAPSED_SECONDS)) {
    shapes.push('stale-process');
  }
  const stoppedForRepair = /Stopped the managed Gateway for Doctor repair/i.test(source);
  const verifiedRestart = /Gateway restarted and verified after Doctor repair/i.test(source);
  const offlineMaintenance = /undergoing offline maintenance/i.test(source);
  const down = gatewayDown === true;
  if (down && stoppedForRepair && !verifiedRestart) shapes.push('gateway-left-stopped');
  else if (down && offlineMaintenance && !verifiedRestart && shapes.length === 0) {
    shapes.push('offline-maintenance');
  }
  const unique = uniqueShapes(shapes);
  if (unique.length === 0) return null;
  const gatewayLeftStopped = down && (
    unique.includes('gateway-left-stopped')
    || unique.includes('offline-maintenance')
    || unique.includes('stale-process')
    || unique.includes('snapshot-loop')
    || unique.includes('content-version-respawn')
    || unique.includes('census-stall')
    || unique.includes('sigterm-cleanup-failed')
  );
  return Object.freeze({
    shapes: unique,
    gatewayLeftStopped,
    restartWillNotFix: true,
  });
}

export function describeStalledDoctor(match) {
  const shapes = Array.isArray(match?.shapes) ? match.shapes : [];
  const parts = ['Doctor is stalled or left cleanup unfinished. Do not run doctor --fix again.'];
  if (match?.gatewayLeftStopped) {
    parts.push('The gateway is stopped. Restarting it while Doctor still holds the offline-maintenance lease crash-loops. Send SIGTERM, wait, then SIGKILL if the doctor process is still there. Start the gateway afterward only if it was running before Doctor stopped it.');
  } else if (shapes.includes('snapshot-loop')) {
    parts.push('The read-only snapshot loop kept running and ignored SIGTERM. SIGKILL was required. Check that the gateway is listening after the doctor process is gone.');
  } else if (shapes.includes('census-stall')) {
    parts.push('Doctor went silent after stopping the managed gateway, then reported that the OpenClaw process census was incomplete. One report stayed in that state for about 79 minutes.');
  } else if (shapes.includes('content-version-respawn') || shapes.includes('sigterm-cleanup-failed')) {
    parts.push('sqlite-source-revision content-version workers kept respawning, and SIGTERM cleanup can fail. Do not start another --fix to reclaim the snapshot.');
  } else {
    parts.push('A doctor process is still running past 15 minutes. ClawFix limits its own doctor invocations to 120 seconds and escalates from SIGTERM to SIGKILL.');
  }
  parts.push('ClawFix will not start an unbounded doctor --fix.');
  return parts.join(' ');
}

// Doctor lint check ids that own legacy heartbeat migration. When a successful
// lint reports one of these, it replaces the local leftover-key finding.
export const HEARTBEAT_DOCTOR_CHECK_IDS = Object.freeze([
  'core/doctor/heartbeat-cadence-migration',
  'core/doctor/heartbeat-scratch-migration',
  'core/doctor/heartbeat-task-cron-migration',
]);

const SAFE_CONFIG_ID = /^[A-Za-z0-9_-]{1,64}$/;

function plainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeConfigId(value) {
  return typeof value === 'string' && SAFE_CONFIG_ID.test(value) ? value : null;
}

export function nativeDoctorFromDiagnostic(diagnostic) {
  const record = diagnostic?.nativeDoctor || diagnostic?.openclaw?.nativeDoctor;
  return plainRecord(record) ? record : null;
}

export function doctorLintSucceeded(nativeDoctor) {
  return plainRecord(nativeDoctor)
    && nativeDoctor.available === true
    && nativeDoctor.timedOut !== true
    && Array.isArray(nativeDoctor.findings);
}

export function legacyHeartbeatPaths(config) {
  const paths = [];
  if (plainRecord(config?.agents?.defaults?.heartbeat)) paths.push('agents.defaults.heartbeat');
  const entries = config?.agents?.entries;
  if (plainRecord(entries)) {
    for (const [id, entry] of Object.entries(entries)) {
      if (!plainRecord(entry?.heartbeat)) continue;
      const safe = safeConfigId(id);
      paths.push(safe ? `agents.entries.${safe}.heartbeat` : 'agents.entries.heartbeat');
    }
  }
  if (Array.isArray(config?.agents?.list)) {
    config.agents.list.forEach((entry, index) => {
      if (!plainRecord(entry?.heartbeat)) return;
      const safe = safeConfigId(entry?.id) || safeConfigId(entry?.name);
      paths.push(safe ? `agents.list.${safe}.heartbeat` : `agents.list.${index}.heartbeat`);
    });
  }
  return paths;
}

function doctorCheckIds(nativeDoctor) {
  if (!doctorLintSucceeded(nativeDoctor)) return [];
  return nativeDoctor.findings
    .map(finding => finding?.checkId)
    .filter(id => typeof id === 'string');
}

function heartbeatDoctorLines(nativeDoctor) {
  if (!doctorLintSucceeded(nativeDoctor)) return [];
  return nativeDoctor.findings
    .filter(finding => HEARTBEAT_DOCTOR_CHECK_IDS.includes(finding?.checkId))
    .map(finding => {
      const path = typeof finding.path === 'string' && finding.path ? ` (${finding.path})` : '';
      const message = String(finding.message || finding.checkId);
      return `${message}${path}`;
    })
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * Retired heartbeat keys and the update-admission / file refusals that fire
 * before Doctor's migration. A successful doctor lint that already reported
 * the heartbeat migration checks covers the key; a timed-out lint does not.
 */
export function classifyLegacyHeartbeat({ config, text = '', nativeDoctor = null } = {}) {
  const source = String(text ?? '');
  const paths = legacyHeartbeatPaths(config);
  const namedHeartbeat = /unrecognized_keys\s*[:=]?\s*\[[^\]]*["']heartbeat["']/i.test(source)
    || /Unrecognized key:\s*"heartbeat"/i.test(source);
  const redactedChild = /agents\.defaults:\s*unrecognized key\s*<key>/i.test(source);
  const admission = /invalid-config/i.test(source) && (
    namedHeartbeat
    || redactedChild
    || (/agents\.defaults:\s*unrecognized key/i.test(source) && paths.includes('agents.defaults.heartbeat'))
  );
  const fileAgent = /Agent "([A-Za-z0-9_-]{1,64})" HEARTBEAT\.md (?:cannot be migrated|was not migrated)/.exec(source);
  const fileBlocked = Boolean(fileAgent) || /symlink target escapes the agent workspace/i.test(source)
    || /HEARTBEAT\.md cannot be migrated/i.test(source);
  const checks = doctorCheckIds(nativeDoctor);
  const keysCoveredByDoctor = checks.some(id => HEARTBEAT_DOCTOR_CHECK_IDS.includes(id));
  const fileCoveredByDoctor = checks.includes('core/doctor/heartbeat-scratch-migration');
  const keyEvidence = paths.length > 0 || namedHeartbeat || admission;
  const showKeys = keyEvidence && !keysCoveredByDoctor;
  const showFile = fileBlocked && !fileCoveredByDoctor;
  if (!showKeys && !showFile && !(keysCoveredByDoctor && keyEvidence)) return null;
  const reported = [...paths];
  if ((namedHeartbeat || (admission && paths.includes('agents.defaults.heartbeat')))
      && !reported.includes('agents.defaults.heartbeat')) {
    reported.unshift('agents.defaults.heartbeat');
  }
  return Object.freeze({
    paths: Object.freeze(reported),
    admission: admission || namedHeartbeat,
    redactedAdmission: admission && !namedHeartbeat && !paths.includes('agents.defaults.heartbeat'),
    fileBlocked: showFile,
    fileAgent: fileAgent?.[1] || null,
    keysCoveredByDoctor,
    fileCoveredByDoctor,
    showKeys,
    doctorLines: Object.freeze(heartbeatDoctorLines(nativeDoctor)),
  });
}

export function describeLegacyHeartbeat(detail) {
  if (!detail) return 'Retired heartbeat configuration needs Doctor migration.';
  const parts = [];
  if (detail.keysCoveredByDoctor && !detail.showKeys && detail.doctorLines.length > 0) {
    const paths = detail.paths.length ? ` Key path: ${detail.paths.join(', ')}.` : '';
    parts.push(`Doctor lint already reported the heartbeat migration.${paths} ${detail.doctorLines.join(' ')}`);
  }
  if (detail.showKeys) {
    if (detail.redactedAdmission && detail.paths.length === 0) {
      parts.push('Update admission returned invalid-config for agents.defaults: unrecognized key. The key name was redacted in that output.');
    } else if (detail.paths.length > 0) {
      parts.push(`Retired heartbeat config at ${detail.paths.join(', ')} is not in the current schema.`);
    }
    if (detail.admission && !detail.redactedAdmission) {
      parts.push('Update admission returned invalid-config before Doctor could migrate this key. A gateway restart does not remove it.');
    }
    parts.push('Run openclaw doctor --fix so Doctor can convert the block into an automation. Do not delete the key first; that drops the saved schedule and model.');
  }
  if (detail.fileBlocked) {
    const who = detail.fileAgent ? `Agent "${detail.fileAgent}" ` : '';
    parts.push(`${who}HEARTBEAT.md cannot be migrated: the symlink target escapes the agent workspace. doctor --fix and update admission refuse this file. Do not delete it from this check.`);
  }
  return parts.join(' ') || 'Retired heartbeat configuration needs Doctor migration.';
}

export function classifyPluginsInstalls({ config, text = '' } = {}) {
  const source = String(text ?? '');
  const fromLog = /plugins:\s*Unrecognized key:\s*"installs"/i.test(source)
    || /Unrecognized key:\s*"installs"/i.test(source);
  let empty = false;
  let populated = false;
  let present = false;
  if (plainRecord(config?.plugins) && Object.hasOwn(config.plugins, 'installs')) {
    present = true;
    const value = config.plugins.installs;
    empty = plainRecord(value) && Object.keys(value).length === 0;
    populated = !empty;
  }
  if (!present && !fromLog) return null;
  return Object.freeze({
    path: 'plugins.installs',
    empty,
    populated,
    fromLog,
  });
}

export function describePluginsInstalls(detail) {
  if (!detail) return 'plugins.installs is rejected as Unrecognized key: "installs".';
  if (detail.empty) {
    return 'plugins.installs is an empty retired key. Gateway startup rejects it as plugins: Unrecognized key: "installs". OpenClaw removes an empty plugins.installs object. Back up openclaw.json, delete only that key, then run openclaw config validate.';
  }
  if (detail.populated) {
    return 'plugins.installs is still present and is not an empty object. Startup can fail with plugins: Unrecognized key: "installs". Populated install records belong in the SQLite plugin index before the key is removed. This check does not delete them.';
  }
  return 'Gateway startup failed with plugins: Unrecognized key: "installs" at plugins.installs. If the value is an empty object, back up the config and delete only that key. If it contains install records, do not delete it by hand.';
}

// Documented OpenClaw engine when the installed package.json cannot be read.
// 22, 23, and 25 are outside this range.
export const FALLBACK_NODE_ENGINE = '>=24.22.1 <25 || >=26.12.1';

export function parseNodeVersion(value) {
  const match = String(value ?? '').trim().match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part) || part < 0 || part > 100000)) return null;
  return Object.freeze({
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    text: `${parts[0]}.${parts[1]}.${parts[2]}`,
  });
}

export function parseNodeEngineRange(expression) {
  const text = String(expression ?? '').trim();
  if (!text || text.length > 200) return null;
  const alternatives = text.split(/\s*\|\|\s*/);
  const parsed = [];
  for (const alternative of alternatives) {
    const tokens = [...alternative.matchAll(/(>=|<=|>|<|=)\s*(\d+(?:\.\d+){0,2})/g)];
    if (tokens.length === 0) return null;
    parsed.push(tokens.map(token => {
      const numbers = token[2].split('.').map(Number);
      while (numbers.length < 3) numbers.push(0);
      return Object.freeze({ op: token[1], version: Object.freeze(numbers.slice(0, 3)) });
    }));
  }
  return parsed;
}

function compareNode(version, check) {
  let diff = 0;
  const left = [version.major, version.minor, version.patch];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== check.version[index]) {
      diff = left[index] - check.version[index];
      break;
    }
  }
  if (check.op === '>=') return diff >= 0;
  if (check.op === '>') return diff > 0;
  if (check.op === '<=') return diff <= 0;
  if (check.op === '<') return diff < 0;
  if (check.op === '=') return diff === 0;
  return false;
}

export function nodeSatisfiesEngine(versionText, expression) {
  const version = parseNodeVersion(versionText);
  const range = parseNodeEngineRange(expression);
  if (!version || !range) return null;
  return range.some(alternative => alternative.every(check => compareNode(version, check)));
}

export function redactHomePath(value, home) {
  let text = redactText(value, home ? { home } : {});
  text = text.replace(/[A-Za-z]:\\Users\\[^\\]+/gi, '~');
  text = text.replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
  return text;
}

function extractEngineExpression(text) {
  const match = String(text ?? '').match(/(>=\d+\.\d+\.\d+(?:\s+<\d+(?:\.\d+\.\d+)?)?(?:\s*\|\|\s*>=\d+\.\d+\.\d+(?:\s+<\d+(?:\.\d+\.\d+)?)?)*)/);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

function runtimeSourceForPath(filePath) {
  const text = String(filePath ?? '');
  if (/\.openclaw[/\\]tools[/\\]node-v\d/.test(text)) return 'companion';
  return 'shell';
}

function pushRuntime(list, runtime) {
  const version = parseNodeVersion(runtime.version);
  if (!version) return;
  const path = runtime.path ? redactHomePath(runtime.path).slice(0, 300) : null;
  const source = runtime.source === 'gateway' || runtime.source === 'companion' || runtime.source === 'shell'
    ? runtime.source
    : runtimeSourceForPath(path);
  const key = `${source}|${path || ''}|${version.text}`;
  if (list.some(item => item.key === key)) return;
  list.push({ key, source, path, version: version.text });
}

function runtimesFromText(text) {
  const source = String(text ?? '');
  const found = [];
  for (const match of source.matchAll(/detected:\s*Node\s+v?(\d+\.\d+\.\d+)\s+at\s+(\S+)/gi)) {
    pushRuntime(found, { source: runtimeSourceForPath(match[2]), path: match[2].replace(/[),.;]+$/, ''), version: match[1] });
  }
  const gateway = source.match(/Active Gateway runtime:\s*node=v?(\d+\.\d+\.\d+)/i);
  if (gateway) pushRuntime(found, { source: 'gateway', version: gateway[1] });
  const detected = source.match(/detected Node\s+v?(\d+\.\d+\.\d+)/i);
  const companion = source.match(/(~?[/\\]?(?:[^\s]*[/\\])?\.openclaw[/\\]tools[/\\]node-v\d+\.\d+\.\d+[/\\]bin[/\\]node)/i);
  if (companion) {
    const fromPath = companion[1].match(/node-v(\d+\.\d+\.\d+)/);
    pushRuntime(found, {
      source: 'companion',
      path: companion[1],
      version: fromPath?.[1] || detected?.[1],
    });
  } else if (detected && !/detected:\s*Node/i.test(source)) {
    pushRuntime(found, { source: 'companion', version: detected[1] });
  }
  const unsupported = source.match(/Node\s+(\d+\.\d+\.\d+)\s+is unsupported/i);
  if (unsupported) pushRuntime(found, { source: 'companion', version: unsupported[1] });
  const current = source.match(/Node\.js\s+.+?\s+is required\s+\(current:\s*v?([^)]+)\)/i);
  if (current) pushRuntime(found, { source: 'shell', version: current[1] });
  return found;
}

function normalizeProvidedRuntimes(value) {
  if (!Array.isArray(value)) return [];
  const found = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    pushRuntime(found, entry);
  }
  return found;
}

/**
 * Which Node binaries are outside OpenClaw's engine range.
 * A compatible gateway node keeps the finding, at lower severity.
 */
export function classifyNodeEngineMismatch({
  engines,
  runtimes,
  text = '',
  runtimeCompatible,
  runtimeRequired,
  runtimeCurrent,
  home,
} = {}) {
  const combined = [text, runtimeRequired, runtimeCurrent].filter(Boolean).join('\n');
  const fromPackage = typeof engines === 'string' && parseNodeEngineRange(engines) ? engines.trim() : null;
  const fromCommand = extractEngineExpression(runtimeRequired) || extractEngineExpression(combined);
  const enginesText = fromPackage || fromCommand || FALLBACK_NODE_ENGINE;
  const enginesSource = fromPackage ? 'package.json engines.node' : fromCommand ? 'OpenClaw version check' : 'documented fallback';
  if (!parseNodeEngineRange(enginesText)) return null;
  const collected = normalizeProvidedRuntimes(runtimes);
  const fromText = runtimesFromText(combined);
  for (const runtime of fromText) {
    pushRuntime(collected, { ...runtime, path: runtime.path ? redactHomePath(runtime.path, home) : null });
  }
  const currentVersion = parseNodeVersion(runtimeCurrent);
  if (currentVersion && !collected.some(item => item.version === currentVersion.text)) {
    pushRuntime(collected, { source: 'shell', version: runtimeCurrent });
  }
  const judged = collected.map(runtime => Object.freeze({
    source: runtime.source,
    path: runtime.path,
    version: runtime.version,
    compatible: nodeSatisfiesEngine(runtime.version, enginesText) === true,
  }));
  const failing = judged.filter(runtime => runtime.compatible !== true);
  const legacyMismatch = runtimeCompatible === false && Boolean(runtimeRequired || runtimeCurrent);
  if (failing.length === 0 && !legacyMismatch) return null;
  if (failing.length === 0) return null;
  const gateway = judged.find(runtime => runtime.source === 'gateway');
  const gatewayCompatible = gateway ? gateway.compatible === true : null;
  return Object.freeze({
    engines: enginesText,
    enginesSource,
    runtimes: Object.freeze(judged),
    failing: Object.freeze(failing),
    gatewayCompatible,
    severity: gatewayCompatible === true ? 'medium' : 'critical',
  });
}

function nodeSourceLabel(source) {
  if (source === 'gateway') return 'Gateway service';
  if (source === 'companion') return 'Companion';
  return 'Shell';
}

function nodeRemedy(runtime) {
  if (runtime.source === 'gateway') {
    return `The gateway service node ${runtime.version}${runtime.path ? ` at ${runtime.path}` : ''} is outside the range. Edit the LaunchAgent plist, systemd unit, or scheduled task so it starts a supported Node. ClawFix does not rewrite the service.`;
  }
  if (runtime.source === 'companion') {
    if (runtime.path && /\.openclaw\/tools\/node-/.test(runtime.path)) {
      return `Companion pinned ${runtime.path} (${runtime.version}). That build is below the current engine floor. Update Companion, or replace that tools node with 24.22.1+ or 26.12.1+. ClawFix does not replace it.`;
    }
    return `Companion or its installer selected Node ${runtime.version}, which is unsupported. Node 22, 23, and 25 are outside the range. Use Node 24.22.1+ or 26.12.1+. ClawFix does not install Node.`;
  }
  return `The shell node ${runtime.version}${runtime.path ? ` at ${runtime.path}` : ''} is what update preflight checks. Point this shell at a Node that satisfies the range, often the Node the gateway service already runs. ClawFix does not change PATH.`;
}

export function describeNodeEngineMismatch(detail) {
  if (!detail) return 'A Node binary is outside OpenClaw\'s supported engine range.';
  const parts = [`OpenClaw's Node engine range is ${detail.engines} (${detail.enginesSource}).`];
  for (const runtime of detail.runtimes) {
    const where = runtime.path ? ` at ${runtime.path}` : '';
    parts.push(`${nodeSourceLabel(runtime.source)} node ${runtime.version}${where} is ${runtime.compatible ? 'inside the supported range' : 'outside the supported range'}.`);
  }
  if (detail.gatewayCompatible === true) {
    parts.push('The gateway service Node is inside the supported range, so this mismatch is lower severity. The failing binary is the shell, the update preflight, or the Companion tools node.');
  }
  for (const runtime of detail.failing) parts.push(nodeRemedy(runtime));
  parts.push('ClawFix does not install or switch Node.');
  return parts.join(' ');
}

const STATE_LOCK_SHAPES = Object.freeze([
  ['state-directory', /owns this state directory/i],
  ['state-lifecycle', /owns state-lifecycle/i],
  ['gateway-lock', /GatewayLockError|failed to acquire gateway (?:state )?lock|cannot verify Gateway ownership|state ownership is no longer current|no longer current; lock removed\/replaced/i],
  ['lease-aborted', /OPENCLAW_STATE_LEASE_ABORTED/],
]);

function lockPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2_147_483_647 ? pid : null;
}

function openClawCommand(command) {
  return /(^|[\s/])openclaw(\s|$)/i.test(command) && !/\bclawfix\b/i.test(command);
}

/**
 * A holder is proven dead only when the pid is gone, or the pid exists and
 * its command is not OpenClaw. Permission failures stay unknown.
 */
export function assessLockHolder({ pid, signalCode, command } = {}) {
  const parsed = lockPid(pid);
  if (!parsed) return null;
  const text = typeof command === 'string' ? command.replace(/\0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  if (signalCode === 'ESRCH') {
    return Object.freeze({ pid: parsed, command: null, status: 'dead', ageSeconds: null, provenDead: true });
  }
  if (signalCode === 'OK' && text && !openClawCommand(text)) {
    return Object.freeze({ pid: parsed, command: text, status: 'reused', ageSeconds: null, provenDead: true });
  }
  if (signalCode === 'OK' && text && openClawCommand(text)) {
    return Object.freeze({ pid: parsed, command: text, status: 'alive', ageSeconds: null, provenDead: false });
  }
  return Object.freeze({
    pid: parsed,
    command: text || null,
    status: 'unknown',
    ageSeconds: null,
    provenDead: false,
  });
}

function holderFromRecord(entry) {
  const pid = lockPid(entry?.pid);
  if (!pid) return null;
  if (entry.status === 'alive' || entry.status === 'dead' || entry.status === 'reused' || entry.status === 'unknown') {
    const command = typeof entry.command === 'string' && entry.command.trim()
      ? entry.command.trim().slice(0, 180)
      : null;
    const ageSeconds = Number.isSafeInteger(entry.ageSeconds) && entry.ageSeconds >= 0 && entry.ageSeconds <= 10 ** 10
      ? entry.ageSeconds
      : null;
    const status = entry.status;
    return Object.freeze({
      pid,
      command,
      status,
      ageSeconds,
      provenDead: status === 'dead' || status === 'reused',
    });
  }
  return assessLockHolder({
    pid,
    signalCode: entry.signalCode,
    command: entry.command,
  });
}

function pidsInLockText(text) {
  const found = [];
  const source = String(text ?? '');
  for (const match of source.matchAll(/"pid"\s*:\s*(\d{1,10})|(?:holder|owner)\s+(?:pid\s*)?(\d{1,10})|\bpid\s*[:=]\s*(\d{1,10})/gi)) {
    const pid = lockPid(match[1] || match[2] || match[3]);
    if (pid && !found.includes(pid)) found.push(pid);
    if (found.length >= 8) break;
  }
  return found;
}

function ageForPid(text, pid) {
  const source = String(text ?? '');
  const specific = source.match(new RegExp(`holder\\s+${pid}[^\\n]{0,120}last renewed\\s+(\\d+)\\s*s`, 'i'))
    || source.match(/last renewed\s+(\d+)\s*s(?:econds)?\s+ago/i);
  if (!specific) return null;
  const age = Number(specific[1]);
  return Number.isSafeInteger(age) && age >= 0 && age <= 10 ** 10 ? age : null;
}

export function stateLockRecoveryAllowed(holders) {
  return Array.isArray(holders) && holders.length > 0 && holders.every(holder => holder?.provenDead === true);
}

export function classifyStateLockDeadlock({ text = '', warnings = [], holders = [] } = {}) {
  const warningText = (Array.isArray(warnings) ? warnings : []).map(warning => {
    if (typeof warning === 'string') return warning;
    return [warning?.errorCode, warning?.message, warning?.checkId].filter(Boolean).join(' ');
  }).join('\n');
  const source = [text, warningText].filter(Boolean).join('\n');
  const shapes = STATE_LOCK_SHAPES.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
  if (shapes.length === 0) return null;
  const byPid = new Map();
  for (const entry of (Array.isArray(holders) ? holders : []).slice(0, 8)) {
    const holder = holderFromRecord(entry);
    if (holder) byPid.set(holder.pid, holder);
  }
  for (const pid of pidsInLockText(source)) {
    if (byPid.has(pid)) continue;
    const ageSeconds = ageForPid(source, pid);
    byPid.set(pid, Object.freeze({
      pid,
      command: null,
      status: 'unknown',
      ageSeconds,
      provenDead: false,
    }));
  }
  const normalized = [...byPid.values()].map(holder => {
    if (holder.ageSeconds != null) return holder;
    const ageSeconds = ageForPid(source, holder.pid);
    return ageSeconds == null ? holder : Object.freeze({ ...holder, ageSeconds });
  });
  const leaseOnly = shapes.length === 1 && shapes[0] === 'lease-aborted';
  return Object.freeze({
    shapes: Object.freeze(shapes),
    holders: Object.freeze(normalized),
    repairable: stateLockRecoveryAllowed(normalized),
    severity: leaseOnly ? 'medium' : 'critical',
  });
}

function formatLockAge(ageSeconds) {
  if (!Number.isSafeInteger(ageSeconds)) return '';
  if (ageSeconds < 90) return `, age ${ageSeconds}s`;
  if (ageSeconds < 7200) return `, age ${Math.round(ageSeconds / 60)}m`;
  return `, age ${Math.round(ageSeconds / 3600)}h`;
}

function describeLockHolder(holder) {
  const command = holder.command ? ` command ${holder.command}` : ' command unavailable';
  const age = formatLockAge(holder.ageSeconds);
  if (holder.status === 'alive') {
    return `Holder pid ${holder.pid}${command} is alive${age}.`;
  }
  if (holder.status === 'dead') {
    return `Holder pid ${holder.pid} does not exist${age}, so that holder is proven dead.`;
  }
  if (holder.status === 'reused') {
    return `Holder pid ${holder.pid} is now${command}${age}. That command is not OpenClaw, so the pid was reused and the recorded holder is proven dead.`;
  }
  return `Holder pid ${holder.pid}${holder.command ? command : ''} liveness was not proven${age}.`;
}

export function describeStateLockDeadlock(detail) {
  if (!detail) return 'OpenClaw state ownership or a state lease is blocked.';
  const parts = ['OpenClaw state ownership or a state lease is blocked.'];
  if (detail.shapes?.includes('state-directory')) parts.push('A startup or doctor step says another command owns this state directory.');
  if (detail.shapes?.includes('state-lifecycle')) parts.push('A holder owns state-lifecycle.');
  if (detail.shapes?.includes('gateway-lock')) parts.push('GatewayLockError or a state-ownership check refused the lock.');
  if (detail.shapes?.includes('lease-aborted')) parts.push('Doctor lint warnings include OPENCLAW_STATE_LEASE_ABORTED, so that check did not run.');
  if (!detail.holders?.length) parts.push('No holder pid was recorded.');
  for (const holder of detail.holders || []) parts.push(describeLockHolder(holder));
  if (detail.repairable) {
    parts.push('Every recorded holder is proven dead or reused by a non-OpenClaw command. The catalog repair may run openclaw gateway recover-lock, then the exact --confirm fingerprint that inspection prints, after copying each lock file aside. It does not kill a process.');
  } else if ((detail.holders || []).some(holder => holder.status === 'alive')) {
    parts.push('A live holder is not repairable. Do not kill it. Stop it through its service manager or container, then run openclaw gateway recover-lock and the --confirm command it prints.');
  } else {
    parts.push('This is detect-only until every holder pid is proven dead or reused by a non-OpenClaw command. Run openclaw gateway recover-lock only after you have confirmed the holder stopped, then run the --confirm command it prints.');
  }
  parts.push('ClawFix does not delete the state directory or SQLite files.');
  return parts.join(' ');
}

const GATEWAY_AUTH_MODES = new Set(['token', 'password', 'none', 'trusted-proxy']);

export function summarizeGatewayAuth(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const gateway = config.gateway;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) {
    return Object.freeze({ present: false, mode: null });
  }
  const auth = gateway.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return Object.freeze({ present: false, mode: null });
  }
  const mode = typeof auth.mode === 'string' && GATEWAY_AUTH_MODES.has(auth.mode) ? auth.mode : null;
  return Object.freeze({ present: true, mode });
}

function authEvidenceText(text, findings) {
  const messages = (Array.isArray(findings) ? findings : [])
    .map(finding => [finding?.message, finding?.checkId, finding?.errorCode].filter(Boolean).join(' '))
    .join('\n');
  return [text, messages].filter(Boolean).join('\n');
}

/**
 * gateway.auth was present and then removed. A missing block alone is not evidence.
 * A backup that still has token or password mode, or the removal log, is.
 */
export function classifyGatewayAuthLoss({ current, backups = [], text = '' } = {}) {
  if (current?.read === true && current.present === true) return null;
  const prior = (Array.isArray(backups) ? backups : []).find(backup => (
    backup?.present === true && (backup.mode === 'token' || backup.mode === 'password')
  ));
  const logged = /gateway\.auth REMOVED/i.test(text)
    && /config reload:\s*gateway\.auth\.mode/i.test(text);
  if (!prior && !logged) return null;
  if (current?.read === true && current.present !== false && !logged) return null;
  return Object.freeze({
    backup: prior ? String(prior.name || '').slice(0, 80) : null,
    mode: prior?.mode || null,
    logged,
  });
}

export function describeGatewayAuthLoss(detail) {
  if (!detail) return 'gateway.auth was removed.';
  const where = detail.backup
    ? `The backup ${detail.backup} still has gateway.auth mode ${detail.mode || 'set'}.`
    : 'The gateway log records gateway.auth REMOVED during config reload: gateway.auth.mode.';
  return [
    'gateway.auth was removed after the gateway rewrote its config.',
    where,
    'The token is not printed.',
    'OpenClaw does not document an automatic migration of that block into the state database.',
    'Restore the gateway.auth block from the rotated backup that still contains it (openclaw.json.bak, .bak.1, .bak.2, or .pre-update), then restart the gateway.',
    'https://github.com/openclaw/openclaw/issues/143131',
    'ClawFix does not restore the block or print the token.',
  ].join(' ');
}

export function classifyAuthProfileMigration({ text = '', findings = [] } = {}) {
  const source = authEvidenceText(text, findings);
  const shapes = [];
  if (/AUTH_PROFILE_MIGRATION_REQUIRED/.test(source)) shapes.push('code');
  if (/requires legacy credential migration/i.test(source)) shapes.push('store');
  if (/Archived a previously migrated legacy auth source without replaying credentials/i.test(source)) shapes.push('archived');
  if (shapes.length === 0) return null;
  return Object.freeze({ shapes: Object.freeze(shapes) });
}

export function describeAuthProfileMigration(detail) {
  const shapes = detail?.shapes || [];
  const parts = ['Auth profile migration is blocking provider credentials.'];
  if (shapes.includes('code')) parts.push('The runtime returns AUTH_PROFILE_MIGRATION_REQUIRED.');
  if (shapes.includes('store')) parts.push('The auth profile store requires legacy credential migration.');
  if (shapes.includes('archived')) parts.push('Doctor archived a previously migrated legacy auth source without replaying credentials.');
  parts.push('OpenClaw\'s documented recovery is openclaw doctor --fix on a build that contains the receipt repair (after 2026.8.2). If the success receipt is already inconsistent, restore the archived auth JSON from backup and run doctor --fix again, or re-authenticate the provider.');
  parts.push('https://github.com/openclaw/openclaw/issues/134608');
  parts.push('ClawFix does not run doctor --fix and does not restore credentials.');
  return parts.join(' ');
}

export function classifyStaleDeviceToken({ text = '', findings = [] } = {}) {
  const source = authEvidenceText(text, findings);
  const shapes = [];
  if (/withheld-cross-device/.test(source)) shapes.push('withheld');
  if (/device token mismatch \(rotate\/reissue device token\)/.test(source)) shapes.push('mismatch');
  if (/stale device-token pattern/.test(source)) shapes.push('stale-pattern');
  if (shapes.length === 0) return null;
  return Object.freeze({ shapes: Object.freeze(shapes) });
}

export function describeStaleDeviceToken(detail) {
  const shapes = detail?.shapes || [];
  const parts = ['A cached operator device token is stale.'];
  if (shapes.includes('mismatch')) parts.push('Gateway connect fails with unauthorized: device token mismatch (rotate/reissue device token).');
  if (shapes.includes('withheld')) parts.push('devices rotate returns tokenDelivery withheld-cross-device, so the replacement token is not delivered.');
  if (shapes.includes('stale-pattern')) parts.push('Doctor calls this a stale device-token pattern that predates the gateway rotation.');
  parts.push('OpenClaw\'s doctor text says to reconnect with shared gateway auth, or run openclaw devices rotate --device <id> --role operator.');
  parts.push('On the reported host both of those left the stale token in place. Passing the shared gateway token explicitly avoids the device-token handshake. The token value is not printed.');
  parts.push('https://github.com/openclaw/openclaw/issues/189206');
  parts.push('ClawFix does not rotate, revoke, or remove the device.');
  return parts.join(' ');
}
