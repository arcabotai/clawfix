import { join } from 'node:path';

import { scanError, scanStarted, scanStep } from './events.js';

// ClawFix Task 4 extracts collectDiagnostics() (cli/bin/clawfix.js) into this console-free,
// transport-neutral, cancellable core in small vertical RED-GREEN slices. This module currently
// implements ONLY the discover, system, and config collection phases (Slice 2). The gateway,
// logs, service, workspace, ports, and native collection bands, pure issue derivation,
// envelope/summary assembly, and cancellation/deadline machinery land in later slices (3-6).
// Nothing in cli/bin/clawfix.js imports this module yet, so its incompleteness does not affect
// the running CLI.
export class DiagnosticsCoreIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiagnosticsCoreIncompleteError';
    this.code = 'NOT_IMPLEMENTED';
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
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

// createDiagnosticsCore takes every ambient boundary the original collectDiagnostics() reached
// for directly (filesystem, OpenClaw, OS facts, environment, clock, hashing, native probes, and
// redaction) as a required injected dependency, so the core itself performs no ambient global
// reads. `redact` has no default: a missing redactor must fail loudly at construction rather than
// silently leak secrets, and injecting it here (rather than importing cli/bin/security.js
// directly) keeps cli/core/ from depending on cli/bin/ — the real redactOutbound is wired in by
// the cli/bin/clawfix.js entrypoint in a later slice.
export function createDiagnosticsCore({
  redact,
  fs,
  openclaw,
  os,
  env,
  clock,
  createHash,
  nativeCollectors,
} = {}) {
  requireFunction(redact, 'redact');
  requireBoundary(fs, 'fs', ['exists', 'readJson']);
  requireBoundary(openclaw, 'openclaw', ['findExecutable', 'npmVersion', 'version']);
  requireBoundary(os, 'os', ['homedir', 'platform', 'release', 'arch', 'hostname', 'nodeVersion']);
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }
  requireBoundary(clock, 'clock', ['now']);
  requireFunction(createHash, 'createHash');
  requireBoundary(nativeCollectors, 'nativeCollectors', ['collectOpenClawVersion']);

  async function discover() {
    const home = os.homedir();
    const openclawDir = await fs.exists(join(home, '.openclaw'))
      ? join(home, '.openclaw')
      : await fs.exists(join(home, '.config', 'openclaw'))
        ? join(home, '.config', 'openclaw')
        : null;
    const openclawBin = (await openclaw.findExecutable()) || '';
    return { openclawDir, openclawBin };
  }

  async function collectSystem(openclawBin) {
    const osName = os.platform();
    const osVersion = os.release();
    const osArch = os.arch();
    const nodeVersion = os.nodeVersion();
    const npmVersion = await openclaw.npmVersion({ timeoutMs: 5000 });
    const hostHash = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);

    const versionResult = openclawBin
      ? await openclaw.version({
        executable: openclawBin,
        timeoutMs: 10_000,
        maxStdoutBytes: 1_200,
        maxStderrBytes: 4_000,
      })
      : null;
    const versionProbe = versionResult
      ? nativeCollectors.collectOpenClawVersion(openclawBin, () => versionResult)
      : { version: '', runtimeCompatible: false, error: 'OpenClaw binary not found' };

    return {
      osName, osVersion, osArch, nodeVersion, npmVersion, hostHash, ocVersion: versionProbe.version,
    };
  }

  async function readConfig(openclawDir) {
    const configPath = openclawDir ? join(openclawDir, 'openclaw.json') : null;
    let config = null;
    let redactedConfig = null;
    if (configPath && await fs.exists(configPath)) {
      config = await fs.readJson(configPath);
      const sanitizedCopy = config && typeof config === 'object' ? { ...config } : {};
      delete sanitizedCopy.env;
      redactedConfig = redact(sanitizedCopy);
      if (!isPlainObject(redactedConfig)) {
        throw new TypeError('redact must return a plain object for an existing configuration');
      }
    }
    return { config, redactedConfig };
  }

  async function runDiagnostics({ revision, emit } = {}) {
    validateRevision(revision);
    if (emit !== undefined && typeof emit !== 'function') {
      throw new TypeError('emit must be a function');
    }
    emit?.(scanStarted({ revision }));

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
      const { openclawDir, openclawBin } = await discover();

      if (!openclawBin && !openclawDir) {
        const message = 'OpenClaw not found on this system.';
        emitTerminal(scanError({ revision, error: { message, code: 'OPENCLAW_NOT_FOUND' } }));
        return Object.freeze({ revision, error: message });
      }

      emit?.(scanStep({
        revision,
        phase: 'discover',
        label: 'Finding OpenClaw',
        data: { binary: openclawBin || null, configDir: openclawDir },
      }));

      const system = await collectSystem(openclawBin);
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

      const { redactedConfig } = await readConfig(openclawDir);
      emit?.(scanStep({
        revision,
        phase: 'config',
        label: 'Checking configuration',
        data: { configExists: redactedConfig !== null },
      }));

      const incomplete = new DiagnosticsCoreIncompleteError(
        'cli/core/diagnostics.js only implements the discover, system, and config phases so far '
        + '(ClawFix Task 4, Slice 2). The gateway, logs, service, workspace, ports, and native '
        + 'collection bands, pure issue derivation, envelope/summary assembly, and '
        + 'cancellation/deadline machinery are implemented in later Task 4 slices (3-6) and are '
        + 'not available yet.',
      );
      emitTerminal(scanError({ revision, error: { message: incomplete.message, code: 'NOT_IMPLEMENTED' } }));
      throw incomplete;
    } catch (error) {
      if (!terminalEmitted) {
        emitTerminal(scanError({ revision, error: { message: toSafeErrorMessage(error), code: 'INTERNAL' } }));
      }
      throw error;
    }
  }

  return Object.freeze({ runDiagnostics });
}
