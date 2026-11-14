import {
  dirname, isAbsolute, join, normalize, resolve, sep,
} from 'node:path';

import {
  scanCompleted, scanError, scanStarted, scanStep,
} from './events.js';

// ClawFix Task 4 extracts collectDiagnostics() (cli/bin/clawfix.js) into this console-free,
// transport-neutral, cancellable core in small vertical RED-GREEN slices. This module currently
// implements the discover, system, config, gateway, logs, service, workspace, ports, and native
// collection bands, pure issue derivation, and envelope/semantic-summary assembly (Slices 2-5).
// Cancellation/deadline machinery lands in a later slice (6), and the cli/bin/clawfix.js
// shim/renderer swap-in lands in Slice 7. Nothing in cli/bin/clawfix.js imports this module yet,
// so its incompleteness does not affect the running CLI.
export class DiagnosticsCoreIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiagnosticsCoreIncompleteError';
    this.code = 'NOT_IMPLEMENTED';
  }
}

// A scan that is aborted (externally, via the caller's signal) rejects with the caller's own
// abort reason when it is an Error; DiagnosticsAbortError is only the fallback for a
// non-Error/absent reason, so callers get one stable, identifiable class to check against.
export class DiagnosticsAbortError extends Error {
  constructor(message = 'Diagnostic scan aborted') {
    super(message);
    this.name = 'DiagnosticsAbortError';
    this.code = 'ABORTED';
  }
}

// A scan that exceeds its end-to-end deadline always rejects with this stable class — there is
// no caller-supplied reason to preserve, unlike abort.
export class DiagnosticsTimeoutError extends Error {
  constructor(deadlineMs) {
    super(`Diagnostic scan exceeded its ${deadlineMs}ms deadline`);
    this.name = 'DiagnosticsTimeoutError';
    this.code = 'TIMEOUT';
  }
}

// Internal control-flow sentinel thrown by a cancelled race()/checkCancelled() call. It is never
// exposed to callers — runDiagnostics catches it and rethrows the cancellation's own
// DiagnosticsAbortError/DiagnosticsTimeoutError instead.
const CANCELLED = Symbol('diagnostics-core-cancelled');

// Structural AbortSignal check (matches cli/adapters/process.js and cli/adapters/openclaw.js):
// duck-typed rather than `instanceof AbortSignal` so a signal from any realm/polyfill still
// qualifies, and so this module never needs to read the ambient AbortSignal/AbortController
// globals just to validate its input.
function isAbortSignalLike(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

// Owns the end-to-end cancellation state for one runDiagnostics() call: the caller's external
// signal (if any) and the single aggregate deadline timer race to decide whether/why the scan is
// cancelled. Whichever settles first wins (settle() below is a no-op once state is set), so late
// timer fires or late abort events after a normal completion are harmless.
//
// This never calls clock.now(): the injected `clock` boundary is reserved for the envelope's
// wall-clock timestamp, and conflating it with deadline bookkeeping would let a test (or a
// caller) that fakes `clock` inadvertently perturb deadline expiry. The deadline is scheduled
// once, for the full `deadlineMs`, entirely through the injected `timers` boundary.
function createCancellation({ signal, deadlineMs, timers }) {
  let state = null; // null | 'aborted' | 'timedOut'
  let reason = null;
  let resolveCancellation;
  const cancellationPromise = new Promise((resolve) => { resolveCancellation = resolve; });
  const childController = new AbortController();

  const settle = (nextState, nextReason) => {
    if (state !== null) return;
    state = nextState;
    reason = nextReason;
    childController.abort(nextReason);
    resolveCancellation();
  };

  const onExternalAbort = () => {
    settle('aborted', signal.reason instanceof Error ? signal.reason : new DiagnosticsAbortError());
  };

  if (signal !== undefined) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timerHandle = timers.setTimeout(() => {
    settle('timedOut', new DiagnosticsTimeoutError(deadlineMs));
  }, deadlineMs);

  return {
    get state() {
      return state;
    },
    get reason() {
      return reason;
    },
    signal: childController.signal,
    // Bounds a per-call timeout option to the smaller of its existing cap and the overall
    // deadline budget — this only ever narrows an existing cap, never widens it, and gives
    // uncapped calls (no prior timeoutMs option) the deadline itself as their cap.
    boundTimeout(existingCapMs) {
      return existingCapMs === undefined ? deadlineMs : Math.min(existingCapMs, deadlineMs);
    },
    checkCancelled() {
      if (state !== null) throw CANCELLED;
    },
    // Races a boundary call against cancellation so a blocked/uncooperative promise (a fake or
    // real fs/OpenClaw call that ignores `signal`) can never hold up the pipeline past
    // abort/deadline. The operation promise always gets its own .then(onFulfilled, onRejected)
    // handler here, so a late resolution/rejection after cancellation is always "handled" and
    // never surfaces as an unhandled rejection, no matter how long the real call keeps running.
    async race(operation) {
      if (state !== null) throw CANCELLED;
      let operationPromise;
      try {
        operationPromise = Promise.resolve(operation());
      } catch (error) {
        operationPromise = Promise.reject(error);
      }
      const outcome = await Promise.race([
        operationPromise.then((value) => ({ value }), (error) => ({ error })),
        cancellationPromise.then(() => ({ cancelled: true })),
      ]);
      if (state !== null) throw CANCELLED;
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    },
    cleanup() {
      timers.clearTimeout(timerHandle);
      if (signal !== undefined) signal.removeEventListener('abort', onExternalAbort);
    },
  };
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireBoundary(value, name, methods) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function`);
    }
  }
  return value;
}

function validateRevision(revision) {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new TypeError('revision must be a non-empty string');
  }
  return revision;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Best-effort extraction of a non-empty string message from whatever an injected boundary threw
// (which may not be a real Error). scanError() requires a non-empty error.message, so this
// guarantees the terminal-event construction itself never fails.
function toSafeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return typeof message === 'string' && message.length > 0 ? message : 'Unknown internal error';
}

// OpenClaw's public display marker. Upstream matches the whole stored value, not a substring
// (openclaw/openclaw src/config/redact-sentinel.ts). ClawFix's own collector marker is
// "***REDACTED***" and must never be treated as this sentinel.
// The same matcher is duplicated in cli/bin/security.js because the production image
// ships that file and does not copy cli/core. Keep the two copies in sync.
export const OPENCLAW_REDACTED_PLACEHOLDER = '__OPENCLAW_REDACTED__';
const PLACEHOLDER_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const PLACEHOLDER_PATH_LIMIT = 32;
const PLACEHOLDER_PATH_DEPTH = 24;
const PLACEHOLDER_PATH_LENGTH = 512;
const REPORTED_PLACEHOLDER_PATH = /^(?:[A-Za-z0-9_-]{1,128})(?:\.[A-Za-z0-9_-]{1,128}){0,23}$/;

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

// Paths only. Values are never copied into the result.
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
// Duplicated in cli/bin/security.js. The production image ships that file
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
// are not this install. Duplicated in cli/bin/security.js. The production
// image ships that file and does not copy cli/core. Keep the two copies in sync.
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
// Duplicated in cli/bin/security.js. The production image ships that file
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

export function narrowUploadedUpdate(record) {
  if (!isUpdateRecord(record)) return null;
  const narrow = {
    currentVersion: parseStoredOpenClawVersion(record.currentVersion),
    availableVersion: parseStoredOpenClawVersion(record.availableVersion),
    channel: record.channel,
    updateAvailable: record.updateAvailable === true,
  };
  if (!narrow.currentVersion || !narrow.availableVersion) return null;
  if (!UPDATE_PACKAGE_CHANNELS.has(narrow.channel)) return null;
  if (Object.keys(record).some(key => !Object.hasOwn(narrow, key))) return null;
  if (narrow.updateAvailable) return openclawUpdateAvailable(narrow) ? narrow : null;
  const comparison = compareOpenClawVersions(narrow.currentVersion, narrow.availableVersion);
  if (comparison === null || comparison < 0) return null;
  if (!releaseFitsUpdateChannel(
    narrow.channel,
    narrow.availableVersion,
    narrow.channel === 'stable' ? 'latest' : narrow.channel,
  )) return null;
  return narrow;
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

const NPM_PACKAGE_FILE_LIMIT = 2_000_000;
const NPM_PATH_LIMIT = 64;
const NPM_LINK_HOPS = 8;
const SOURCE_TREE_MARKERS = ['.git', 'src/entry.ts', 'pnpm-lock.yaml'];
const PLUGIN_PATH_NOT_FOUND = /plugin path not found:\s*([^\s"'`]+)/g;
const LIFECYCLE_INCOMPLETE = /openclaw: package lifecycle is incomplete\b/;

function blankInstall(manager) {
  return {
    manager,
    packageJson: false,
    binTarget: false,
    distEntry: false,
    pluginPathMissing: false,
    lifecycleIncomplete: false,
    packageRoot: null,
    version: null,
  };
}

function missingFsError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function pathParts(filePath) {
  return normalize(filePath).split(sep).filter(Boolean);
}

function foreignManager(filePath) {
  for (const part of pathParts(filePath)) {
    if (part === '.pnpm' || part === 'pnpm') return 'pnpm';
    if (part === '.yarn' || part === 'yarn') return 'yarn';
    if (part === '.bun' || part === 'bun') return 'bun';
  }
  return null;
}

function lastNpmPackageRoot(filePath) {
  const normalized = normalize(filePath);
  if (!isAbsolute(normalized)) return null;
  const parts = pathParts(normalized);
  let index = -1;
  for (let i = 0; i <= parts.length - 3; i += 1) {
    if (parts[i] === 'lib' && parts[i + 1] === 'node_modules' && parts[i + 2] === 'openclaw') {
      index = i;
    }
  }
  if (index < 0) return null;
  return sep + parts.slice(0, index + 3).join(sep);
}

function isInsidePath(root, candidate) {
  const rootNorm = normalize(root);
  const cand = normalize(candidate);
  return cand === rootNorm || cand.startsWith(`${rootNorm}${sep}`);
}

function redactInstallRoot(root, home) {
  let text = normalize(root);
  if (home && home !== '/' && (text === home || text.startsWith(`${normalize(home)}${sep}`))) {
    text = `~${text.slice(normalize(home).length)}`;
  }
  return sanitizeNpmPackageRoot(text);
}

function safeRelative(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 240 || isAbsolute(text) || text.includes('\0')) return null;
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return null;
  return parts.join(sep);
}

async function lstatOrMissing(fs, file) {
  try {
    return { info: await fs.lstat(file) };
  } catch (error) {
    if (missingFsError(error)) return { missing: true };
    throw error;
  }
}

async function regularFileState(fs, file) {
  const state = await lstatOrMissing(fs, file);
  if (state.missing) return state;
  if (!state.info.isSymbolicLink()) return state;
  let target;
  try {
    target = await fs.realpath(file);
  } catch (error) {
    if (missingFsError(error)) return { missing: true };
    throw error;
  }
  const followed = await lstatOrMissing(fs, target);
  if (followed.missing) return followed;
  return { info: followed.info, target };
}

async function isSourceTree(fs, root) {
  for (const marker of SOURCE_TREE_MARKERS) {
    const state = await lstatOrMissing(fs, join(root, marker));
    if (!state.missing) return true;
  }
  return false;
}

async function resolveBinLocation(fs, binPath, stat) {
  let current = binPath;
  let info = stat;
  for (let hop = 0; hop < NPM_LINK_HOPS && info?.isSymbolicLink(); hop += 1) {
    let target;
    try {
      target = await fs.readlink(current);
    } catch (error) {
      if (missingFsError(error)) return null;
      throw error;
    }
    if (typeof target !== 'string' || !target || target.length > 1024 || target.includes('\0')) return null;
    const next = normalize(isAbsolute(target) ? target : resolve(dirname(current), target));
    const nextState = await lstatOrMissing(fs, next);
    if (nextState.missing) return next;
    current = next;
    info = nextState.info;
  }
  return info?.isSymbolicLink() ? null : current;
}

async function firstOpenClawBin(fs, pathEnv, fallback) {
  const directories = String(pathEnv || '').split(':').filter(Boolean).slice(0, NPM_PATH_LIMIT);
  const candidates = directories.map(directory => join(directory, 'openclaw'));
  if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
  for (const candidate of candidates) {
    if (!candidate || candidate.length > 1024 || candidate.includes('\0')) continue;
    const state = await lstatOrMissing(fs, candidate);
    if (!state.missing) return { path: candidate, info: state.info };
  }
  return null;
}

function binRelativeFromPackage(pkg) {
  const declared = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.openclaw;
  return safeRelative(declared) || 'openclaw.mjs';
}

function pluginPathInside(root, raw, home) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text || text.length > 512 || /[\0\r\n]/.test(text)) return null;
  if (text.startsWith('~')) {
    if (!home || home === '/') return null;
    text = `${normalize(home)}${text.slice(1)}`;
  }
  if (!isAbsolute(text)) return null;
  const normalized = normalize(text);
  if (!isInsidePath(root, normalized) || normalized === normalize(root)) return null;
  return normalized;
}

async function bundledPluginMissing(fs, root, home, text) {
  const pattern = new RegExp(PLUGIN_PATH_NOT_FOUND.source, 'g');
  const paths = [];
  for (const match of String(text || '').matchAll(pattern)) {
    const pluginPath = pluginPathInside(root, match[1], home);
    if (pluginPath) paths.push(pluginPath);
  }
  for (const pluginPath of paths) {
    const state = await lstatOrMissing(fs, pluginPath);
    if (state.missing) return true;
  }
  return false;
}

async function readOpenClawPackage(fs, root) {
  const file = join(root, 'package.json');
  const state = await regularFileState(fs, file);
  if (state.missing) return { present: false };
  if (!state.info.isFile() || !Number.isSafeInteger(state.info.size) || state.info.size > NPM_PACKAGE_FILE_LIMIT) {
    return { present: false };
  }
  let rootReal = root;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    if (!missingFsError(error)) throw error;
  }
  const target = state.target || file;
  if (!isInsidePath(rootReal, target)) return { present: false };
  let text;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (missingFsError(error)) return { present: false };
    throw error;
  }
  if (typeof text !== 'string' || text.length > NPM_PACKAGE_FILE_LIMIT) return { present: false };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: false };
    if (parsed.name !== 'openclaw') return { present: true, named: false };
    return {
      present: true,
      named: true,
      version: parsed.version,
      binRelative: binRelativeFromPackage(parsed),
    };
  } catch {
    return { present: false };
  }
}

async function classifyResolvedInstall(fs, binPath, location, home, versionText) {
  const foreign = foreignManager(location) || foreignManager(binPath);
  if (foreign) return blankInstall(foreign);
  const lexicalRoot = lastNpmPackageRoot(location);
  if (!lexicalRoot) {
    const parent = dirname(location);
    if (await isSourceTree(fs, parent) || await isSourceTree(fs, location)) return blankInstall('source');
    return blankInstall('unknown');
  }
  const prefix = dirname(dirname(dirname(lexicalRoot)));
  if (normalize(binPath) !== join(prefix, 'bin', 'openclaw')) return blankInstall('unknown');
  const rootState = await lstatOrMissing(fs, lexicalRoot);
  if (rootState.missing) {
    const record = blankInstall('npm');
    record.packageRoot = redactInstallRoot(lexicalRoot, home);
    record.version = parsePrintedOpenClawVersion(versionText);
    record.lifecycleIncomplete = LIFECYCLE_INCOMPLETE.test(String(versionText || ''));
    return record;
  }
  let realRoot = lexicalRoot;
  try {
    realRoot = normalize(await fs.realpath(lexicalRoot));
  } catch (error) {
    if (!missingFsError(error)) throw error;
  }
  const realForeign = foreignManager(realRoot);
  if (realForeign) return blankInstall(realForeign);
  if (lastNpmPackageRoot(realRoot) !== realRoot) {
    if (await isSourceTree(fs, realRoot)) return blankInstall('source');
    return blankInstall('unknown');
  }
  if (await isSourceTree(fs, realRoot)) return blankInstall('source');

  const pkg = await readOpenClawPackage(fs, realRoot);
  if (pkg.named === false) return blankInstall('unknown');
  const binRelative = pkg.binRelative || 'openclaw.mjs';
  const binState = await regularFileState(fs, join(realRoot, binRelative));
  const entryJs = await regularFileState(fs, join(realRoot, 'dist', 'entry.js'));
  const entryMjs = await regularFileState(fs, join(realRoot, 'dist', 'entry.mjs'));
  const record = blankInstall('npm');
  record.packageJson = pkg.present === true && pkg.named === true;
  record.binTarget = isRegularFile(binState);
  record.distEntry = isRegularFile(entryJs) || isRegularFile(entryMjs);
  record.pluginPathMissing = await bundledPluginMissing(fs, realRoot, home, versionText);
  record.lifecycleIncomplete = LIFECYCLE_INCOMPLETE.test(String(versionText || ''));
  record.packageRoot = redactInstallRoot(lexicalRoot, home);
  record.version = parseStoredOpenClawVersion(pkg.version) ?? parsePrintedOpenClawVersion(versionText);
  return record;
}

function isRegularFile(state) {
  return state?.info?.isFile() === true;
}

// Local, offline look at the openclaw bin and its package directory. A broken
// symlink is still a candidate: an interrupted npm install leaves the bin in
// place and removes the file it points at. Anything that is not the Unix npm
// global layout returns a non-npm manager so the detector does not fire.
export async function inspectOpenClawInstall({
  binPath = '',
  pathEnv = '',
  fs,
  home = '',
  platform = '',
  versionText = '',
} = {}) {
  if (platform === 'win32') return blankInstall('unknown');
  if (!fs || typeof fs.lstat !== 'function' || typeof fs.readlink !== 'function'
    || typeof fs.realpath !== 'function' || typeof fs.readFile !== 'function') {
    return null;
  }
  try {
    const bin = await firstOpenClawBin(fs, pathEnv, binPath);
    if (!bin) return null;
    const location = await resolveBinLocation(fs, bin.path, bin.info);
    if (!location) return blankInstall('unknown');
    return await classifyResolvedInstall(fs, bin.path, location, home, versionText);
  } catch {
    return null;
  }
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

// deriveIssues() is the verbatim-behavior port of the original collectDiagnostics() "Local Issue
// Detection" block (cli/bin/clawfix.js lines ~860-1098). It is a pure function: every fact it
// reasons about (config, per-band collection results) is read from the `collected` argument, and
// it performs no filesystem/process/console/clock/network access and touches no ambient global.
// It also never mutates its input — every pushed issue is a freshly-constructed object, and the
// trailing `kind` defaulting loop below mutates only those freshly-constructed local objects, not
// anything reachable from `collected`.
function codexServiceTierIsHealthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'priority' || normalized === 'fast';
}

function mem0PluginEntry(config) {
  const entry = config?.plugins?.entries?.['openclaw-mem0'];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return entry;
}

const DOCTOR_SECURITY_CHECK_ID = 'core/doctor/security';
const GATEWAY_AUTH_CHECK_ID = 'core/doctor/gateway-auth';
const LOOPBACK_NO_AUTH_CHECK_ID = 'gateway.loopback_no_auth';
// Exact hint from openclaw doctor-gateway-auth.ts for a missing token.
// SecretRef failures use a different hint and must not take this repair.
const MISSING_GATEWAY_TOKEN_FIX_HINT = 'Run `openclaw doctor --fix --generate-gateway-token` to generate a token, then restart the Gateway.';
const NATIVE_CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function doctorSecurityAlias(finding) {
  if (finding?.checkId !== DOCTOR_SECURITY_CHECK_ID) return '';
  const requirement = typeof finding.requirement === 'string' ? finding.requirement : '';
  return NATIVE_CHECK_ID.test(requirement) ? requirement : '';
}

function isMissingGatewayTokenFinding(finding) {
  return finding?.checkId === GATEWAY_AUTH_CHECK_ID
    && finding.severity === 'warning'
    && finding.path === 'gateway.auth.token'
    && !finding.requirement
    && finding.fixHint === MISSING_GATEWAY_TOKEN_FIX_HINT;
}

function doctorRepairAlias(finding) {
  if (isMissingGatewayTokenFinding(finding)) return LOOPBACK_NO_AUTH_CHECK_ID;
  return doctorSecurityAlias(finding);
}

export function deriveIssues(collected) {
  const {
    config,
    system,
    gateway,
    logs,
    serviceHealth,
    workspace,
    ports,
    nativeDoctor,
    nativeConfig,
    nativeStatus,
    nativeSecurity,
  } = collected;

  const issues = [];

  const gatewayPortFinding = ports.gateway?.finding;
  if (gatewayPortFinding) {
    issues.push({
      severity: 'high',
      kind: 'failure',
      text: gatewayPortFinding.message,
      source: 'clawfix-port-probe',
      nativeCheckId: gatewayPortFinding.checkId,
      path: gatewayPortFinding.path,
    });
  }

  const activeModelRefs = [];
  const addActiveModelRef = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      activeModelRefs.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(addActiveModelRef);
    }
  };
  const defaults = config?.agents?.defaults || {};
  addActiveModelRef(defaults.model);
  addActiveModelRef(defaults.model?.primary);
  addActiveModelRef(defaults.model?.fallbacks);
  addActiveModelRef(defaults.compaction?.model);
  addActiveModelRef(defaults.subagents?.model);
  if (Array.isArray(config?.agents?.list)) {
    for (const agent of config.agents.list) {
      addActiveModelRef(agent?.model);
      addActiveModelRef(agent?.model?.primary);
      addActiveModelRef(agent?.model?.fallbacks);
    }
  }
  const agentRuntimes = [
    defaults.agentRuntime,
    ...(Array.isArray(config?.agents?.list) ? config.agents.list.map((agent) => agent?.agentRuntime) : []),
  ].filter(Boolean);
  const hasPiFallback = agentRuntimes.some((runtime) => (
    runtime === 'pi'
    || runtime?.id === 'pi'
    || runtime?.fallback === 'pi'
  ));
  const hasNativeCodexRuntime = agentRuntimes.some((runtime) => (
    runtime === 'codex'
    || runtime?.id === 'codex'
  ));
  const codexPlugin = config?.plugins?.entries?.codex || null;
  const codexPluginEnabled = !!codexPlugin && codexPlugin.enabled !== false;
  const codexAppServer = codexPlugin?.config?.appServer || {};
  const shellCodexHomeMatchesExpected = workspace?.codexHome?.matchesExpected === true;
  const combinedLogs = [logs.errorLogs, logs.stderrLogs, logs.gatewayLogTail, gateway.gatewayStatus]
    .filter(Boolean).join('\n');

  const { gatewayStatus } = gateway;
  const gatewayLiveness = readGatewayLiveness(gatewayStatus);
  const gatewayRunning = gatewayLiveness === 'up';
  const gatewayFailed = gatewayLiveness === 'down';
  const listenerPid = Number(ports.gateway?.pid);
  const expectedGatewayPid = Number.parseInt(String(gateway.gatewayPid || ''), 10);
  const competingPortOwner = ports.gateway?.listening === true
    && Number.isSafeInteger(listenerPid) && listenerPid > 0 && (
      (Number.isSafeInteger(expectedGatewayPid) && expectedGatewayPid > 0 && listenerPid !== expectedGatewayPid)
      || !gateway.gatewayPid
    );
  if ((gatewayFailed || (!gatewayRunning && !/warning/i.test(gatewayStatus))) && !competingPortOwner) {
    issues.push({ severity: 'critical', text: 'Gateway is not running' });
  }
  if (competingPortOwner) {
    issues.push({ severity: 'critical', text: 'Port conflict detected' });
  }
  if (system.runtimeCompatible === false && system.runtimeRequired) {
    issues.push({
      severity: 'critical',
      text: `OpenClaw requires Node ${system.runtimeRequired} (current: ${system.runtimeCurrent || system.nodeVersion})`,
      source: 'openclaw-runtime',
    });
  }
  if ((config?.plugins?.load?.paths || []).some((path) => (
    typeof path === 'string' && /openclaw\/dist\/extensions\//.test(path)
  )) || /ignored plugins\.load\.paths entry.*bundled plugin directory/i.test(combinedLogs)) {
    issues.push({ severity: 'medium', text: 'Stale bundled plugin load paths configured' });
  }
  if (codexPluginEnabled && (activeModelRefs.some((ref) => String(ref).startsWith('openai-codex/')) || hasPiFallback)) {
    issues.push({ knownIssueId: 'pi-backed-openai-codex-route', severity: 'high', text: 'PI-backed openai-codex route active instead of native Codex harness' });
  }
  if (/Codex cannot access session files.*\.codex[\/\\]sessions|Operation not permitted.*\.codex[\/\\]sessions|permission denied.*\.codex[\/\\]sessions/i.test(combinedLogs)) {
    issues.push({ knownIssueId: 'codex-session-store-permission', severity: 'high', text: 'Codex session-store permission failure' });
  }
  if (codexPluginEnabled && hasNativeCodexRuntime && !shellCodexHomeMatchesExpected) {
    issues.push({ knownIssueId: 'codex-shell-home-mismatch', severity: 'medium', text: 'Shell CODEX_HOME does not match OpenClaw Codex home' });
  }
  if (codexPluginEnabled
      && (hasNativeCodexRuntime || activeModelRefs.some((ref) => String(ref).startsWith('openai/')))
      && !codexServiceTierIsHealthy(codexAppServer.serviceTier)) {
    issues.push({ knownIssueId: 'codex-service-tier-not-fast', severity: 'low', kind: 'optimization', text: 'Codex app-server fast tier is not enabled' });
  }
  const codexRequestTimeoutMs = Number(codexAppServer.requestTimeoutMs ?? 60000);
  const activeMemoryTimeoutMs = Number(config?.plugins?.entries?.['active-memory']?.config?.timeoutMs ?? NaN);
  const codexTimeoutSymptoms = (
    /EMBEDDED FALLBACK: Gateway agent failed|gateway closed \((1006|1012)\)|codex app-server startup aborted/i.test(combinedLogs)
    || /active-memory:.*status=timeout|lane=.*active-memory.*durationMs=\d+.*codex app-server startup aborted/i.test(combinedLogs)
  );
  if (codexPluginEnabled && hasNativeCodexRuntime && codexTimeoutSymptoms
      && (codexRequestTimeoutMs <= 60000 || activeMemoryTimeoutMs <= 60000)) {
    issues.push({ knownIssueId: 'native-codex-timeout-boundary', severity: 'high', text: 'Native Codex timeout boundary can force gateway fallback' });
  }

  const sigtermCount = (logs.gatewayLogTail.match(/signal SIGTERM/gi) || []).length;
  const restartCount = (logs.gatewayLogTail.match(/listening.*PID/gi) || []).length;
  if (config?.update?.auto?.enabled === true && (sigtermCount >= 2 || restartCount >= 3)) {
    issues.push({ severity: 'critical', text: 'Auto-update causing gateway restart loop' });
  } else if (config?.update?.auto?.enabled === true) {
    issues.push({ severity: 'medium', text: 'Auto-update enabled (risk of restart loops)' });
  }

  const reloadCount = (logs.gatewayLogTail.match(/config change detected.*evaluating reload/gi) || []).length;
  if (reloadCount >= 3) {
    issues.push({ severity: 'high', text: `Config reload cascade detected (${reloadCount} reloads in recent logs)` });
  }

  if (serviceHealth.runs > 2 && (serviceHealth.uptimeSeconds || 0) < 300) {
    issues.push({ severity: 'critical', text: `Gateway crash loop — ${serviceHealth.runs} restarts, only ${serviceHealth.uptimeStr} uptime` });
  } else if ((serviceHealth.nRestarts || 0) > 0) {
    issues.push({ severity: 'high', text: `Gateway has restarted ${serviceHealth.nRestarts} time(s) (systemd)` });
  }

  const handshakeSpam = (logs.stderrLogs.match(/invalid handshake.*chrome-extension|closed before connect.*chrome-extension/gi) || []).length;
  if (handshakeSpam >= 5) {
    issues.push({ severity: 'medium', text: 'Browser Relay extension spamming invalid handshakes' });
  }

  if (logs.errLogSizeMB > 50) {
    issues.push({ severity: 'medium', text: `Error log is ${logs.errLogSizeMB}MB (should be <50MB)` });
  }

  const matrixTimeouts = (logs.stderrLogs.match(/ESOCKETTIMEDOUT/gi) || []).length;
  if (matrixTimeouts >= 3) {
    issues.push({ severity: 'low', text: 'Matrix sync timeouts spamming error log' });
  }

  if (mem0PluginEntry(config)?.config?.enableGraph === true) {
    issues.push({ severity: 'high', text: 'Mem0 enableGraph requires Pro plan (will silently fail)' });
  }
  const placeholderPaths = collectOpenClawRedactedPlaceholderPaths(config);
  if (placeholderPaths.length > 0) {
    issues.push({
      knownIssueId: 'redacted-placeholder-corruption',
      severity: 'high',
      text: 'Persisted OpenClaw redaction placeholders in config',
      description: describeOpenClawRedactedPlaceholders(placeholderPaths),
      path: placeholderPaths.join(', '),
    });
  }
  const newerConfig = configWrittenByNewerVersion({
    openclaw: { version: system?.ocVersion },
    config,
  });
  if (newerConfig) {
    issues.push({
      knownIssueId: 'config-written-by-newer-version',
      severity: 'medium',
      text: 'Config written by a newer OpenClaw version',
      description: describeConfigWrittenByNewerVersion(newerConfig),
    });
  }
  const incompleteInstall = incompleteNpmInstall(collected.install);
  if (incompleteInstall) {
    issues.push({
      knownIssueId: 'incomplete-npm-install',
      severity: 'high',
      text: 'Incomplete global npm install of OpenClaw',
      description: describeIncompleteNpmInstall(incompleteInstall),
    });
  }
  const availableUpdate = openclawUpdateAvailable(collected.updateAvailability);
  if (availableUpdate) {
    issues.push({
      knownIssueId: 'openclaw-update-available',
      severity: 'low',
      text: 'OpenClaw update available',
      description: describeOpenClawUpdateAvailable(availableUpdate),
    });
  }
  if (config?.agents?.defaults && !config.agents.defaults.contextPruning) {
    issues.push({ severity: 'medium', kind: 'optimization', text: 'No context pruning configured' });
  }
  if (config?.agents?.defaults && !config.agents.defaults.compaction?.memoryFlush?.enabled) {
    issues.push({ severity: 'medium', kind: 'optimization', text: 'Memory flush not enabled (data loss on compaction)' });
  }
  if (!workspace.hasSoul && workspace.workspaceDir) {
    issues.push({ severity: 'low', kind: 'optimization', text: 'No SOUL.md found (agent has no personality)' });
  }
  if (Number.isSafeInteger(collected.stuckSessionWindows?.count) && collected.stuckSessionWindows.count > 0) {
    const agents = Array.isArray(collected.stuckSessionWindows.agents)
      ? collected.stuckSessionWindows.agents.filter(agent => typeof agent === 'string' && agent.length > 0)
      : [];
    issues.push({
      knownIssueId: 'stuck-invalid-session-window',
      severity: 'medium',
      kind: 'warning',
      text: 'Invalid session window is still marked running',
      description: agents.length > 0
        ? `${collected.stuckSessionWindows.count} session window(s) still have status running on an empty invalid session entry (${agents.join(', ')}). sessions list and doctor --session-sqlite inspect do not report them. No automatic delete is available.`
        : `${collected.stuckSessionWindows.count} session window(s) still have status running on an empty invalid session entry. sessions list and doctor --session-sqlite inspect do not report them. No automatic delete is available.`,
    });
  }
  if (workspace.memoryFiles === 0 && workspace.workspaceDir) {
    issues.push({ severity: 'low', kind: 'optimization', text: 'No memory files found' });
  }

  if (nativeConfig.available && nativeConfig.valid === false) {
    // The headline stays a sentence the operator can act on; the validator's own text is
    // detail, not the title. Surfacing it raw produced findings titled
    // "JSON5 parse failed: SyntaxError: JSON5: invalid character 'i' at 1:8".
    const configDetail = nativeConfig.errors[0]?.message || '';
    issues.push({
      severity: 'high',
      text: 'OpenClaw config schema validation failed',
      description: configDetail || 'OpenClaw reported the config as invalid without detail.',
      source: 'openclaw-config',
      nativeCheckId: 'config/schema-invalid',
      path: nativeConfig.errors[0]?.path || null,
    });
  }

  if (
    nativeStatus.available
    && nativeStatus.gateway.reachable === false
    && !issues.some((issue) => /gateway.*not running|gateway.*unreachable/i.test(issue.text))
  ) {
    // Same rule as the config case above. `gateway.error` is a machine string — when the probe
    // timed out it was literally "timeout", which reached the user as a critical finding titled
    // "timeout" and read like an OpenClaw fault rather than a probe that gave up.
    const probeDetail = String(nativeStatus.gateway.error || '').trim();
    issues.push({
      severity: 'critical',
      text: 'OpenClaw gateway is unreachable',
      description: probeDetail
        ? `Gateway probe failed: ${probeDetail}`
        : 'The gateway did not answer a status probe.',
      source: 'openclaw-status',
      nativeCheckId: 'status/gateway-unreachable',
    });
  }

  if (
    competingPortOwner
    && nativeStatus.available
    && nativeStatus.gateway.reachable === false
  ) {
    const owner = ports.gateway.process;
    const { pid } = ports.gateway;
    issues.push({
      severity: 'critical',
      text: `Gateway port ${gateway.gatewayPort} is occupied${owner ? ` by ${owner}` : ''}${pid ? ` (PID ${pid})` : ''}, but OpenClaw cannot reach it`,
      source: 'clawfix-port-probe',
      nativeCheckId: 'runtime/gateway-port-conflict',
    });
  }

  for (const finding of nativeSecurity.findings) {
    if (finding.severity === 'info') continue;
    issues.push({
      severity: finding.severity === 'critical' ? 'critical'
        : finding.severity === 'error' ? 'high' : 'medium',
      text: finding.title || finding.message,
      description: finding.message,
      source: finding.source,
      nativeCheckId: finding.checkId,
      path: finding.path,
      fixHint: finding.fixHint,
    });
  }

  // A lint process killed for its time budget is not an OpenClaw finding, even
  // when the killed process had already written a partial JSON envelope.
  if (nativeDoctor?.timedOut !== true) for (const finding of nativeDoctor.findings) {
    // Match on the detail too, not just the headline. Findings that carry an upstream message as
    // their detail (config/schema-invalid holds the validator's text) would otherwise be
    // reported twice — once with an actionable title, once as the raw parser output.
    // core/doctor/security stores the original audit id in requirement, and the
    // missing-token gateway-auth shape is the same repair as gateway.loopback_no_auth.
    const alias = doctorRepairAlias(finding);
    const message = String(finding.message || '').toLowerCase();
    const duplicate = issues.some((issue) => (
      issue.nativeCheckId === finding.checkId
      || (alias && (issue.nativeCheckId === alias || issue.securityCheckId === alias))
      || String(issue.text || '').toLowerCase() === message
      || String(issue.description || '').toLowerCase() === message
    ));
    if (duplicate) continue;
    const requirement = typeof finding.requirement === 'string' && finding.requirement
      ? finding.requirement
      : '';
    issues.push({
      severity: finding.severity === 'error' ? 'high' : 'medium',
      text: finding.message,
      source: 'openclaw-doctor',
      nativeCheckId: finding.checkId,
      ...(alias ? { securityCheckId: alias } : {}),
      ...(requirement ? { requirement } : {}),
      path: finding.path,
      fixHint: finding.fixHint,
    });
  }

  for (const issue of issues) {
    if (!issue.kind) {
      issue.kind = issue.severity === 'critical' || issue.severity === 'high'
        ? 'failure'
        : 'warning';
    }
  }

  return issues;
}

// createDiagnosticsCore takes every ambient boundary the original collectDiagnostics() reached
// for directly (filesystem, OpenClaw, OS facts, environment, clock, hashing, native probes, and
// redaction) as a required injected dependency, so the core itself performs no ambient global
// reads. `redact` has no default: a missing redactor must fail loudly at construction rather than
// silently leak secrets, and injecting it here (rather than importing cli/bin/security.js
// directly) keeps cli/core/ from depending on cli/bin/ — the real redactOutbound is wired in by
// the cli/bin/clawfix.js entrypoint in a later slice.
export function createDiagnosticsCore({
  version,
  redact,
  fs,
  openclaw,
  os,
  env,
  clock,
  createHash,
  nativeCollectors,
  timers,
  collectStuckSessionWindows,
} = {}) {
  requireNonEmptyString(version, 'version');
  requireFunction(redact, 'redact');
  requireBoundary(fs, 'fs', ['exists', 'readJson', 'stat', 'readdir', 'countMarkdownFiles']);
  requireBoundary(openclaw, 'openclaw', [
    'findExecutable', 'npmVersion', 'version',
    'gatewayStatusText', 'gatewayProcesses', 'readFileTail', 'serviceManagerState',
  ]);
  requireBoundary(os, 'os', ['homedir', 'platform', 'release', 'arch', 'hostname', 'nodeVersion']);
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }
  requireBoundary(clock, 'clock', ['now']);
  requireFunction(createHash, 'createHash');
  requireBoundary(timers, 'timers', ['setTimeout', 'clearTimeout']);
  requireBoundary(nativeCollectors, 'nativeCollectors', [
    'collectOpenClawVersion',
    'collectListeningPort',
    'collectNativeDoctor',
    'collectNativeConfigValidation',
    'collectNativeStatus',
    'collectNativeSecurityAudit',
    'collectOpenClawUpdateStatus',
  ]);

  async function discover(cancellation) {
    const home = os.homedir();
    const openclawDir = await cancellation.race(() => fs.exists(join(home, '.openclaw')))
      ? join(home, '.openclaw')
      : await cancellation.race(() => fs.exists(join(home, '.config', 'openclaw')))
        ? join(home, '.config', 'openclaw')
        : null;
    const openclawBin = (await cancellation.race(() => openclaw.findExecutable())) || '';
    return { home, openclawDir, openclawBin };
  }

  async function collectSystem(openclawBin, cancellation) {
    cancellation.checkCancelled();
    const osName = os.platform();
    const osVersion = os.release();
    const osArch = os.arch();
    const nodeVersion = os.nodeVersion();
    cancellation.checkCancelled();
    const npmVersion = await cancellation.race(() => openclaw.npmVersion({
      timeoutMs: cancellation.boundTimeout(5000),
      signal: cancellation.signal,
    }));
    cancellation.checkCancelled();
    const hostHash = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);
    cancellation.checkCancelled();

    const versionResult = openclawBin
      ? await cancellation.race(() => openclaw.version({
        executable: openclawBin,
        timeoutMs: cancellation.boundTimeout(10_000),
        maxStdoutBytes: 1_200,
        maxStderrBytes: 4_000,
        signal: cancellation.signal,
      }))
      : null;
    cancellation.checkCancelled();
    const versionProbe = versionResult
      ? nativeCollectors.collectOpenClawVersion(openclawBin, () => versionResult)
      : { version: '', runtimeCompatible: false, error: 'OpenClaw binary not found' };
    cancellation.checkCancelled();

    return {
      osName,
      osVersion,
      osArch,
      nodeVersion,
      npmVersion,
      hostHash,
      ocVersion: versionProbe.version,
      // Kept off the uploaded system object. The install inspector reads it for the
      // upstream incomplete-install strings and does not forward the raw text.
      versionCommandText: [versionProbe.version, versionProbe.error].filter(Boolean).join('\n'),
      // Retained (not emitted in the system scan.step, which only surfaces ocVersion) for the
      // native band's runtime-compatibility gate below, and for later Task 4 slices' envelope.
      runtimeCompatible: versionProbe.runtimeCompatible,
      runtimeRequired: versionProbe.runtimeRequired ?? null,
      runtimeCurrent: versionProbe.runtimeCurrent ?? null,
    };
  }

  function collectPorts(gatewayPort, cancellation) {
    // Sync spawnSync-backed collectors retain intrinsic per-process timeouts (each port collector
    // may run multiple 5s probes). They cannot be interrupted while one call is executing, so
    // cancellation is checked before and after every collector to prevent the next probe.
    cancellation.checkCancelled();
    const gateway = { port: gatewayPort, ...nativeCollectors.collectListeningPort(gatewayPort) };
    cancellation.checkCancelled();
    const browserCdp = { port: 18800, ...nativeCollectors.collectListeningPort(18800) };
    cancellation.checkCancelled();
    const browserControl = { port: 18791, ...nativeCollectors.collectListeningPort(18791) };
    cancellation.checkCancelled();
    return { gateway, browserCdp, browserControl };
  }

  function projectPortEvidence(evidence) {
    const projected = {
      port: evidence.port,
      valid: evidence.valid === true,
      available: evidence.available === true,
      listening: evidence.listening === true ? true : evidence.listening === false ? false : null,
      process: typeof evidence.process === 'string' ? evidence.process : null,
      pid: Number.isSafeInteger(evidence.pid) ? evidence.pid : null,
      endpoint: typeof evidence.endpoint === 'string' ? evidence.endpoint : null,
      collector: evidence.collector === 'lsof' || evidence.collector === 'ss'
        ? evidence.collector
        : null,
    };
    if (evidence.finding && typeof evidence.finding === 'object') {
      projected.finding = {
        checkId: typeof evidence.finding.checkId === 'string' ? evidence.finding.checkId : '',
        severity: typeof evidence.finding.severity === 'string' ? evidence.finding.severity : '',
        path: typeof evidence.finding.path === 'string' ? evidence.finding.path : '',
        message: typeof evidence.finding.message === 'string' ? evidence.finding.message : '',
      };
    }
    return projected;
  }

  function collectNative(openclawBin, runtimeCompatible, cliVersion, cancellation) {
    // Native collectors are sync spawnSync boundaries with intrinsic timeouts. Cancellation cannot
    // interrupt a collector already executing, but is observed before and after each call.
    cancellation.checkCancelled();
    let nativeDoctor = openclawBin
      ? nativeCollectors.collectNativeDoctor(openclawBin)
      : {
        available: false, timedOut: false, checksRun: 0, checksSkipped: 0, findings: [],
      };
    if (nativeDoctor?.timedOut === true) {
      nativeDoctor = {
        available: false,
        timedOut: true,
        state: 'timed out',
        exitCode: Number.isInteger(nativeDoctor.exitCode) ? nativeDoctor.exitCode : null,
        error: 'OpenClaw Doctor timed out',
        checksRun: 0,
        checksSkipped: 0,
        findings: [],
      };
    }
    cancellation.checkCancelled();

    const canRunNativeEvidence = Boolean(openclawBin) && runtimeCompatible === true;
    const nativeConfig = canRunNativeEvidence
      ? nativeCollectors.collectNativeConfigValidation(openclawBin)
      : {
        available: false, valid: null, warnings: [], errors: [],
      };
    cancellation.checkCancelled();
    const nativeStatus = canRunNativeEvidence
      ? nativeCollectors.collectNativeStatus(openclawBin)
      : { available: false };
    cancellation.checkCancelled();
    const nativeSecurity = canRunNativeEvidence
      ? nativeCollectors.collectNativeSecurityAudit(openclawBin)
      : { available: false, findings: [] };
    cancellation.checkCancelled();
    // Update status is its own OpenClaw command. An old CLI that does not have
    // it, and a runtime that cannot start, both return no record.
    const updateAvailability = openclawBin
      ? nativeCollectors.collectOpenClawUpdateStatus(openclawBin, cliVersion)
      : null;
    cancellation.checkCancelled();

    return {
      nativeDoctor, nativeConfig, nativeStatus, nativeSecurity, updateAvailability,
    };
  }

  async function collectGateway(config, openclawBin, cancellation) {
    let gatewayStatus = 'unknown';
    if (openclawBin) {
      gatewayStatus = await cancellation.race(() => openclaw.gatewayStatusText({
        executable: openclawBin,
        timeoutMs: cancellation.boundTimeout(5000),
        signal: cancellation.signal,
      })) || 'could not check';
    }
    const gatewayPort = config?.gateway?.port || 18789;
    const gatewayPid = await cancellation.race(() => openclaw.gatewayProcesses({
      timeoutMs: cancellation.boundTimeout(5000),
      signal: cancellation.signal,
    }));
    const statusLine = (
      gatewayStatus.split('\n').find((line) => /runtime:|listening|running|stopped|not running/i.test(line))
      || gatewayStatus.split('\n')[0]
    ).trim();
    const running = readGatewayLiveness(gatewayStatus) === 'up';
    return {
      gatewayStatus, gatewayPort, gatewayPid, statusLine, running,
    };
  }

  async function collectLogs(openclawDir, cancellation) {
    const logPath = openclawDir ? join(openclawDir, 'logs', 'gateway.log') : null;
    const errLogPath = openclawDir ? join(openclawDir, 'logs', 'gateway.err.log') : null;
    let errorLogs = '';
    let stderrLogs = '';
    let gatewayLogTail = '';
    let logSizeMB = 0;
    let errLogSizeMB = 0;

    if (logPath && await cancellation.race(() => fs.exists(logPath))) {
      try {
        const logStat = await cancellation.race(() => fs.stat(logPath));
        logSizeMB = Math.round(logStat.size / 1024 / 1024);
        const tailContent = (await cancellation.race(() => openclaw.readFileTail(logPath, {
          maxLines: 500,
          maxBytes: 1024 * 1024,
        }))).text;
        const lines = tailContent.split('\n');
        errorLogs = lines
          .filter((line) => /error|warn|fail|crash|EADDRINUSE|EACCES/i.test(line))
          .slice(-30)
          .join('\n');
        gatewayLogTail = lines
          .filter((line) => /signal SIGTERM|listening.*PID|config change detected.*reload|update available/i.test(line))
          .slice(-20)
          .join('\n');
      } catch (error) {
        if (error === CANCELLED) throw error;
        // fail-open: matches the original collector's swallow-and-continue behavior
      }
    }

    if (errLogPath && await cancellation.race(() => fs.exists(errLogPath))) {
      try {
        const errStat = await cancellation.race(() => fs.stat(errLogPath));
        errLogSizeMB = Math.round(errStat.size / 1024 / 1024);
        stderrLogs = (await cancellation.race(() => openclaw.readFileTail(errLogPath, {
          maxLines: 200,
          maxBytes: 1024 * 1024,
        }))).text;
      } catch (error) {
        if (error === CANCELLED) throw error;
        // fail-open
      }
    }

    return {
      errorLogs,
      stderrLogs,
      gatewayLogTail,
      logSizeMB,
      errLogSizeMB,
      hasErrors: errorLogs.length > 0,
      errorLineCount: errorLogs ? errorLogs.split('\n').length : 0,
      hasGatewaySignals: gatewayLogTail.length > 0,
      gatewaySignalLineCount: gatewayLogTail ? gatewayLogTail.split('\n').length : 0,
      hasStderr: stderrLogs.trim().length > 0,
    };
  }

  async function collectWorkspace(config, injectedEnv, home, openclawDir, cancellation) {
    const workspaceDir = config?.agents?.defaults?.workspace || '';
    let mdFiles = 0;
    let memoryFiles = 0;
    let hasSoul = false;
    let hasAgents = false;
    let workspaceExists = false;

    if (workspaceDir && await cancellation.race(() => fs.exists(workspaceDir))) {
      workspaceExists = true;
      hasSoul = await cancellation.race(() => fs.exists(join(workspaceDir, 'SOUL.md')));
      hasAgents = await cancellation.race(() => fs.exists(join(workspaceDir, 'AGENTS.md')));

      try {
        mdFiles = await cancellation.race(() => fs.countMarkdownFiles(workspaceDir));
      } catch (error) {
        if (error === CANCELLED) throw error;
        // fail-open
      }

      const memDir = join(workspaceDir, 'memory');
      if (await cancellation.race(() => fs.exists(memDir))) {
        try {
          const memEntries = await cancellation.race(() => fs.readdir(memDir));
          memoryFiles = memEntries.filter((name) => name.endsWith('.md')).length;
        } catch (error) {
          if (error === CANCELLED) throw error;
          // fail-open
        }
      }
    }

    const plugins = Object.entries(config?.plugins?.entries || {}).map(([name, pluginConfig]) => ({
      name,
      enabled: pluginConfig?.enabled !== false,
    }));
    const expectedCodexHome = openclawDir
      ? join(openclawDir, 'codex-home')
      : join(home, '.openclaw', 'codex-home');
    const shellCodexHomeSet = Boolean(injectedEnv.CODEX_HOME);

    return {
      workspaceDir,
      workspaceExists,
      mdFiles,
      memoryFiles,
      hasSoul,
      hasAgents,
      plugins,
      codexHome: {
        expected: expectedCodexHome,
        shellSet: shellCodexHomeSet,
        matchesExpected: injectedEnv.CODEX_HOME === expectedCodexHome,
      },
    };
  }

  async function readConfig(openclawDir, cancellation) {
    const configPath = openclawDir ? join(openclawDir, 'openclaw.json') : null;
    let config = null;
    let redactedConfig = null;
    if (configPath && await cancellation.race(() => fs.exists(configPath))) {
      config = await cancellation.race(() => fs.readJson(configPath));
      if (config && typeof config === 'object') {
        const sanitizedCopy = { ...config };
        delete sanitizedCopy.env;
        redactedConfig = redact(sanitizedCopy);
        cancellation.checkCancelled();
        if (!isPlainObject(redactedConfig)) {
          throw new TypeError('redact must return a plain object for an existing configuration');
        }
      }
    }
    return { config, redactedConfig };
  }

  // Doctor lint may use the full upstream 120s budget. The scan deadline has to
  // outlive that spawn plus the shorter probes around it, or a doctor that is
  // still working is discarded as a scan timeout.
  async function runDiagnostics({ revision, emit, signal, deadlineMs = 180_000 } = {}) {
    validateRevision(revision);
    if (emit !== undefined && typeof emit !== 'function') {
      throw new TypeError('emit must be a function');
    }
    if (signal !== undefined && !isAbortSignalLike(signal)) {
      throw new TypeError('signal must be AbortSignal-like');
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      throw new TypeError('deadlineMs must be a positive safe integer');
    }

    const cancellation = createCancellation({ signal, deadlineMs, timers });

    // Every started scan must produce exactly one terminal event (scan.completed XOR
    // scan.error), never both and never a second attempt if the sink itself throws while
    // delivering the first one. `terminalEmitted` is set BEFORE the sink is invoked, so a
    // throwing sink still leaves the flag correctly set and the catch below will not retry.
    let terminalEmitted = false;
    const emitTerminal = (event) => {
      terminalEmitted = true;
      emit?.(event);
    };

    try {
      emit?.(scanStarted({ revision }));
      cancellation.checkCancelled();
      const { home, openclawDir, openclawBin } = await discover(cancellation);

      if (!openclawBin && !openclawDir) {
        const message = 'OpenClaw not found on this system.';
        emitTerminal(scanError({ revision, error: { message, code: 'OPENCLAW_NOT_FOUND' } }));
        // Soft outcome: the scan completed successfully and found no OpenClaw.
        // Callers (especially --dry-run / local-only) should treat this as exit 0.
        return Object.freeze({ revision, error: message, errorCode: 'OPENCLAW_NOT_FOUND' });
      }

      emit?.(scanStep({
        revision,
        phase: 'discover',
        label: 'Finding OpenClaw',
        data: { binary: openclawBin || null, configDir: openclawDir },
      }));

      const system = await collectSystem(openclawBin, cancellation);
      emit?.(scanStep({
        revision,
        phase: 'system',
        label: 'Collecting system information',
        data: {
          os: system.osName,
          osVersion: system.osVersion,
          arch: system.osArch,
          nodeVersion: system.nodeVersion,
          npmVersion: system.npmVersion,
          ocVersion: system.ocVersion,
          hostHash: system.hostHash,
        },
      }));

      const { config, redactedConfig } = await readConfig(openclawDir, cancellation);
      const redactedPlaceholderPaths = collectOpenClawRedactedPlaceholderPaths(config);
      const cliVersion = parsePrintedOpenClawVersion(system.ocVersion);
      const configLastTouchedVersion = parseStoredOpenClawVersion(config?.meta?.lastTouchedVersion);
      emit?.(scanStep({
        revision,
        phase: 'config',
        label: 'Checking configuration',
        data: { configExists: redactedConfig !== null },
      }));

      const gateway = await collectGateway(config, openclawBin, cancellation);
      emit?.(scanStep({
        revision,
        phase: 'gateway',
        label: 'Checking gateway status',
        data: {
          port: gateway.gatewayPort,
          statusLine: gateway.statusLine,
          pid: gateway.gatewayPid || null,
          running: gateway.running,
        },
      }));

      const logs = await collectLogs(openclawDir, cancellation);
      emit?.(scanStep({
        revision,
        phase: 'logs',
        label: 'Reading recent logs',
        data: {
          logSizeMB: logs.logSizeMB,
          errLogSizeMB: logs.errLogSizeMB,
          hasErrors: logs.hasErrors,
          errorLineCount: logs.errorLineCount,
          hasGatewaySignals: logs.hasGatewaySignals,
          gatewaySignalLineCount: logs.gatewaySignalLineCount,
          hasStderr: logs.hasStderr,
        },
      }));

      const serviceHealth = await cancellation.race(() => openclaw.serviceManagerState({
        timeoutMs: cancellation.boundTimeout(5000),
        signal: cancellation.signal,
      }));
      emit?.(scanStep({
        revision,
        phase: 'service',
        label: 'Checking service health',
        data: {
          manager: serviceHealth.manager ?? null,
          state: serviceHealth.state ?? null,
          subState: serviceHealth.subState ?? null,
          pid: serviceHealth.pid ?? null,
          runs: serviceHealth.runs ?? null,
          nRestarts: serviceHealth.nRestarts ?? null,
          lastExitCode: serviceHealth.lastExitCode ?? null,
          uptimeStr: serviceHealth.uptimeStr ?? null,
          uptimeSeconds: serviceHealth.uptimeSeconds ?? null,
        },
      }));

      const workspace = await collectWorkspace(config, env, home, openclawDir, cancellation);
      emit?.(scanStep({
        revision,
        phase: 'workspace',
        label: 'Checking workspace',
        data: {
          path: workspace.workspaceDir || null,
          exists: workspace.workspaceExists,
          mdFiles: workspace.mdFiles,
          memoryFiles: workspace.memoryFiles,
          hasSoul: workspace.hasSoul,
          hasAgents: workspace.hasAgents,
          plugins: workspace.plugins,
          codexHome: workspace.codexHome,
        },
      }));

      const ports = collectPorts(gateway.gatewayPort, cancellation);
      emit?.(scanStep({
        revision,
        phase: 'ports',
        label: 'Checking port availability',
        data: {
          gateway: projectPortEvidence(ports.gateway),
          browserCdp: projectPortEvidence(ports.browserCdp),
          browserControl: projectPortEvidence(ports.browserControl),
        },
      }));

      const {
        nativeDoctor, nativeConfig, nativeStatus, nativeSecurity, updateAvailability: collectedUpdate,
      } = collectNative(openclawBin, system.runtimeCompatible, system.ocVersion, cancellation);
      const updateAvailability = narrowUploadedUpdate(collectedUpdate);
      emit?.(scanStep({
        revision,
        phase: 'native',
        label: 'Running OpenClaw native health checks',
        data: {
          doctor: {
            available: nativeDoctor.available === true,
            timedOut: nativeDoctor.timedOut === true,
            ...(nativeDoctor.timedOut === true ? { state: 'timed out' } : {}),
            checksRun: nativeDoctor.checksRun ?? 0,
            checksSkipped: nativeDoctor.checksSkipped ?? 0,
            findingCount: nativeDoctor.timedOut === true || !Array.isArray(nativeDoctor.findings)
              ? 0
              : nativeDoctor.findings.length,
          },
          config: {
            available: nativeConfig.available,
            valid: nativeConfig.valid ?? null,
          },
          status: {
            available: nativeStatus.available,
            reachable: nativeStatus.available ? (nativeStatus.gateway?.reachable ?? null) : null,
          },
          security: {
            available: nativeSecurity.available,
            critical: nativeSecurity.available ? (nativeSecurity.summary?.critical ?? 0) : 0,
            warning: nativeSecurity.available ? (nativeSecurity.summary?.warning ?? 0) : 0,
            info: nativeSecurity.available ? (nativeSecurity.summary?.info ?? 0) : 0,
          },
          update: updateAvailability && typeof updateAvailability === 'object' ? {
            channel: updateAvailability.channel,
            updateAvailable: updateAvailability.updateAvailable === true,
          } : null,
        },
      }));

      const commandText = [
        system.versionCommandText,
        // Timeout text is a collector state. It must not be read as version or
        // install evidence, and partial lint stdout must not become a finding.
        ...(nativeDoctor?.timedOut === true ? [] : [
          nativeDoctor?.error,
          ...(Array.isArray(nativeDoctor?.findings)
            ? nativeDoctor.findings.map(finding => finding?.message)
            : []),
        ]),
      ].filter(text => typeof text === 'string' && text).join('\n');
      let install = null;
      if (typeof fs.lstat === 'function' && typeof fs.readlink === 'function'
        && typeof fs.realpath === 'function' && typeof fs.readFile === 'function') {
        install = await cancellation.race(() => inspectOpenClawInstall({
          binPath: openclawBin,
          pathEnv: env.PATH || env.Path || '',
          fs,
          home,
          platform: system.osName,
          versionText: commandText,
        }));
      }
      cancellation.checkCancelled();
          let stuckSessionWindows = null;
      if (typeof collectStuckSessionWindows === 'function' && openclawDir) {
        try {
          stuckSessionWindows = await cancellation.race(() => collectStuckSessionWindows(openclawDir));
        } catch (error) {
          if (error === CANCELLED) throw error;
          stuckSessionWindows = null;
        }
      }
      const issues = deriveIssues({
        config,
        system,
        gateway,
        logs,
        serviceHealth,
        workspace,
        ports,
        nativeDoctor,
        nativeConfig,
        nativeStatus,
        nativeSecurity,
        install,
        updateAvailability,
        stuckSessionWindows,
      });
      cancellation.checkCancelled();
      const optimizationCount = issues.filter((issue) => issue.kind === 'optimization').length;
      const severity = {
        critical: issues.filter((issue) => issue.severity === 'critical').length,
        high: issues.filter((issue) => issue.severity === 'high').length,
        medium: issues.filter((issue) => issue.severity === 'medium').length,
        low: issues.filter((issue) => issue.severity === 'low').length,
      };
      emit?.(scanStep({
        revision,
        phase: 'issues',
        label: 'Deriving diagnostic issues',
        data: {
          total: issues.length,
          actionable: issues.length - optimizationCount,
          optimizations: optimizationCount,
          severity,
        },
      }));

      const browserConfigured = Boolean(
        openclawDir && await cancellation.race(() => fs.exists(join(openclawDir, 'browser'))),
      );
      cancellation.checkCancelled();
      const now = clock.now();
      cancellation.checkCancelled();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('clock.now() must return a valid Date');
      }

      const diagnosticEnvelope = {
        version,
        timestamp: now.toISOString(),
        hostHash: system.hostHash,
        system: {
          os: system.osName,
          osVersion: system.osVersion,
          arch: system.osArch,
          nodeVersion: system.nodeVersion,
          npmVersion: system.npmVersion,
        },
        openclaw: {
          version: cliVersion || system.ocVersion || 'unknown',
          binary: openclawBin || 'not found',
          configDir: openclawDir || 'not found',
          configExists: config !== null,
          gatewayStatus: gateway.gatewayStatus,
          gatewayPid: gateway.gatewayPid || 'none',
          gatewayPort: gateway.gatewayPort,
          processExists: Boolean(gateway.gatewayPid),
          portListening: ports.gateway.listening === true,
          runtimeCompatible: system.runtimeCompatible,
          runtimeRequired: system.runtimeRequired,
          runtimeCurrent: system.runtimeCurrent,
          ...(redactedPlaceholderPaths.length > 0 ? { redactedPlaceholderPaths } : {}),
          ...(cliVersion ? { cliVersion } : {}),
          ...(configLastTouchedVersion ? { configLastTouchedVersion } : {}),
          ...(install ? { install } : {}),
          ...(updateAvailability ? { updateAvailability } : {}),
          ...(Number.isSafeInteger(stuckSessionWindows?.count) && stuckSessionWindows.count > 0
            ? { stuckSessionWindows: {
              count: stuckSessionWindows.count,
              agents: Array.isArray(stuckSessionWindows.agents) ? stuckSessionWindows.agents.slice(0, 8) : [],
            } }
            : {}),
        },
        config: redactedConfig,
        nativeConfig,
        nativeDoctor,
        nativeStatus,
        nativeSecurity,
        ports,
        logs: {
          errors: logs.errorLogs,
          stderr: logs.stderrLogs,
          gatewayLog: logs.gatewayLogTail,
          errLogSizeMB: logs.errLogSizeMB,
          logSizeMB: logs.logSizeMB,
        },
        service: serviceHealth,
        workspace: {
          path: workspace.workspaceDir || 'unknown',
          exists: workspace.workspaceExists,
          mdFiles: workspace.mdFiles,
          memoryFiles: workspace.memoryFiles,
          hasSoul: workspace.hasSoul,
          hasAgents: workspace.hasAgents,
        },
        browser: {
          status: browserConfigured ? 'configured' : 'not configured',
        },
        codex: {
          expectedHome: workspace.codexHome.expected,
          shellCodexHomeSet: workspace.codexHome.shellSet,
          shellCodexHomeMatchesExpected: workspace.codexHome.matchesExpected,
        },
      };
      const diagnostic = redact(diagnosticEnvelope);
      cancellation.checkCancelled();
      if (!isPlainObject(diagnostic)) {
        throw new TypeError('redact must return a plain object for the diagnostic envelope');
      }

      const actionableIssueCount = issues.length - optimizationCount;
      const gatewayLabel = gateway.running
        ? `running (pid ${gateway.gatewayPid || '?'}, port ${gateway.gatewayPort})`
        : 'not running';
      const configLabel = config ? 'loaded' : 'not found';
      const issueLabel = actionableIssueCount === 0
        ? optimizationCount > 0
          ? `Healthy; ${optimizationCount} optimization(s)`
          : 'No issues'
        : `${actionableIssueCount} issue(s), ${optimizationCount} optimization(s)`;
      const summary = {
        gateway: {
          running: gateway.running,
          pid: gateway.gatewayPid || null,
          port: gateway.gatewayPort,
          label: gatewayLabel,
        },
        config: {
          loaded: Boolean(config),
          label: configLabel,
        },
        issues: {
          actionable: actionableIssueCount,
          optimizations: optimizationCount,
          label: issueLabel,
        },
        node: system.nodeVersion,
        os: `${system.osName === 'darwin' ? 'macOS' : system.osName} ${system.osVersion}`,
        ocVersion: system.ocVersion || 'unknown',
      };

      cancellation.checkCancelled();
      emitTerminal(scanCompleted({ revision, summary, findings: issues }));
      return { revision, diagnostic, issues, summary };
    } catch (error) {
      const failure = error === CANCELLED ? cancellation.reason : error;
      const code = error === CANCELLED
        ? (cancellation.state === 'timedOut' ? 'TIMEOUT' : 'ABORTED')
        : 'INTERNAL';
      if (!terminalEmitted) {
        emitTerminal(scanError({
          revision,
          error: { message: toSafeErrorMessage(failure), code },
        }));
      }
      throw failure;
    } finally {
      cancellation.cleanup();
    }
  }

  return Object.freeze({ runDiagnostics });
}
