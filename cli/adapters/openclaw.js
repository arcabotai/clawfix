import { constants as fsConstants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { TextDecoder } from 'node:util';

import { processAdapter as defaultProcessAdapter } from './process.js';

export const OPENCLAW_TIMEOUT_MS = 10_000;
export const OPENCLAW_MAX_OUTPUT_BYTES = 256 * 1024;
export const OPENCLAW_COMPATIBILITY_PATHS = Object.freeze([
  '/opt/homebrew/bin/openclaw',
  '/usr/local/bin/openclaw',
]);

const NOT_FOUND_RESULT = Object.freeze({
  status: null,
  signal: null,
  stdout: '',
  stderr: '',
  errorSummary: 'OpenClaw executable not found',
  errorCode: 'ENOENT',
  timedOut: false,
  aborted: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitExceeded: false,
});

const ABORTED_RESULT = Object.freeze({
  status: null,
  signal: null,
  stdout: '',
  stderr: '',
  errorSummary: 'OpenClaw invocation aborted',
  errorCode: 'ABORT_ERR',
  timedOut: false,
  aborted: true,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitExceeded: false,
});

const DISCOVERY_TIMEOUT_RESULT = Object.freeze({
  status: null,
  signal: null,
  stdout: '',
  stderr: '',
  errorSummary: 'OpenClaw executable discovery timed out',
  errorCode: 'ETIMEDOUT',
  timedOut: true,
  aborted: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitExceeded: false,
});

const CANCELLED = Symbol('OpenClaw invocation cancelled');
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function envValue(env, name, caseInsensitive = false) {
  if (!caseInsensitive) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function windowsExtensions(env) {
  const raw = envValue(env, 'PATHEXT', true) || '.COM;.EXE;.BAT;.CMD';
  const seen = new Set();
  const extensions = [];
  for (const item of raw.split(';')) {
    if (item.length === 0) continue;
    const extension = item.startsWith('.') ? item : `.${item}`;
    const key = extension.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      extensions.push(extension);
    }
  }
  return extensions;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function snapshotInvocation(argv, options, env) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  if (!Array.isArray(argv)
    || argv.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new TypeError('argv must be an array of strings without NUL bytes');
  }

  const timeoutMs = options.timeoutMs ?? OPENCLAW_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? OPENCLAW_MAX_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? OPENCLAW_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  for (const [name, value] of Object.entries({ maxStdoutBytes, maxStderrBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }

  const signal = options.signal;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError('signal must be an AbortSignal');
  }

  const cwd = options.cwd;
  if (cwd !== undefined
    && typeof cwd !== 'string'
    && !(cwd instanceof URL && cwd.protocol === 'file:')) {
    throw new TypeError('cwd must be a string or file URL');
  }

  const callEnv = options.env;
  if (callEnv !== undefined && !isPlainObject(callEnv)) {
    throw new TypeError('env must be a non-null plain object');
  }

  const windowsHide = options.windowsHide;
  if (windowsHide !== undefined && typeof windowsHide !== 'boolean') {
    throw new TypeError('windowsHide must be a boolean');
  }

  const executable = options.executable;
  if (executable !== undefined
    && (typeof executable !== 'string' || executable.length === 0 || executable.includes('\0'))) {
    throw new TypeError('executable must be a non-empty string without NUL bytes');
  }

  return Object.freeze({
    executable,
    argv: Object.freeze([...argv]),
    processOptions: Object.freeze({
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      signal,
      cwd: cwd instanceof URL ? new URL(cwd) : cwd,
      env: callEnv === undefined ? env : Object.freeze({ ...callEnv }),
      windowsHide,
      shell: false,
    }),
  });
}

function createInvocationControl(signal, timeoutMs) {
  const startedAt = Date.now();
  let state = signal?.aborted ? 'aborted' : null;
  let timer;
  let resolveCancellation;
  const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });

  const settle = (nextState) => {
    if (state !== null) return;
    state = nextState;
    resolveCancellation(nextState);
  };
  const remaining = () => {
    if (state === 'timedOut') return 0;
    const value = timeoutMs - (Date.now() - startedAt);
    if (value > 0) return value;
    settle('timedOut');
    return 0;
  };
  const scheduleTimeout = () => {
    const delay = remaining();
    if (delay === 0) return;
    timer = setTimeout(() => {
      if (remaining() > 0) scheduleTimeout();
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
  };
  const onAbort = () => settle('aborted');

  if (state === null) {
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) settle('aborted');
    if (state === null) scheduleTimeout();
  }

  return {
    get state() {
      return state;
    },
    remaining,
    throwIfCancelled() {
      if (state !== null || remaining() === 0) throw CANCELLED;
    },
    async race(operation) {
      this.throwIfCancelled();
      let operationPromise;
      try {
        operationPromise = Promise.resolve(operation());
      } catch (error) {
        operationPromise = Promise.reject(error);
      }
      const outcome = await Promise.race([
        operationPromise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
        cancellation.then(() => ({ cancelled: true })),
      ]);
      if (state !== null || remaining() === 0 || outcome.cancelled) throw CANCELLED;
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    },
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export function createOpenClawAdapter({
  fs = nodeFs,
  env = process.env,
  platform = process.platform,
  processAdapter = defaultProcessAdapter,
} = {}) {
  if (!fs || typeof fs.access !== 'function' || typeof fs.stat !== 'function') {
    throw new TypeError('fs must provide access and stat functions');
  }
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object');
  }
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new TypeError('platform must be a non-empty string');
  }
  if (!processAdapter || typeof processAdapter.run !== 'function') {
    throw new TypeError('processAdapter must provide a run function');
  }

  const environment = Object.freeze({ ...env });
  const isWindows = platform === 'win32';
  const pathApi = isWindows ? win32 : posix;
  const delimiter = isWindows ? ';' : ':';

  async function isUsableFile(candidate, control) {
    try {
      if (control) {
        await control.race(() => fs.access(
          candidate,
          isWindows ? fsConstants.F_OK : fsConstants.X_OK,
        ));
      } else {
        await fs.access(candidate, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
      }
      const stat = control
        ? await control.race(() => fs.stat(candidate))
        : await fs.stat(candidate);
      return stat.isFile();
    } catch (error) {
      if (error === CANCELLED) throw error;
      return false;
    }
  }

  async function discoverExecutable(control) {
    const rawPath = envValue(environment, 'PATH', isWindows) ?? '';
    const directories = rawPath.split(delimiter).filter((entry) => entry.length > 0);
    const names = isWindows
      ? windowsExtensions(environment).map((extension) => `openclaw${extension}`)
      : ['openclaw'];

    for (const directory of directories) {
      for (const name of names) {
        control?.throwIfCancelled();
        const candidate = pathApi.join(directory, name);
        if (await isUsableFile(candidate, control)) return candidate;
      }
    }

    if (!isWindows) {
      for (const candidate of OPENCLAW_COMPATIBILITY_PATHS) {
        control?.throwIfCancelled();
        if (await isUsableFile(candidate, control)) return candidate;
      }
    }
    control?.throwIfCancelled();
    return null;
  }

  function findExecutable() {
    return discoverExecutable();
  }

  async function invokeSnapshot(invocation) {
    const control = createInvocationControl(
      invocation.processOptions.signal,
      invocation.processOptions.timeoutMs,
    );
    try {
      if (control.state === 'aborted') return ABORTED_RESULT;
      let executable;
      try {
        executable = invocation.executable ?? await discoverExecutable(control);
      } catch (error) {
        if (error !== CANCELLED) throw error;
        return control.state === 'aborted' ? ABORTED_RESULT : DISCOVERY_TIMEOUT_RESULT;
      }
      if (executable === null) return NOT_FOUND_RESULT;
      control.throwIfCancelled();
      const timeoutMs = control.remaining();
      if (timeoutMs === 0) return DISCOVERY_TIMEOUT_RESULT;
      const processOptions = Object.freeze({
        ...invocation.processOptions,
        timeoutMs,
      });
      return processAdapter.run(executable, invocation.argv, processOptions);
    } finally {
      control.cleanup();
    }
  }

  function invoke(argv, options = {}) {
    return invokeSnapshot(snapshotInvocation(argv, options, environment));
  }

  function runSystem(executable, argv, options = {}) {
    const invocation = snapshotInvocation(argv, { ...options, executable }, environment);
    return processAdapter.run(
      invocation.executable,
      invocation.argv,
      invocation.processOptions,
    );
  }

  function processText(result) {
    if (result.status !== 0
      || result.errorCode != null
      || result.errorSummary != null
      || result.signal != null
      || result.timedOut
      || result.aborted
      || result.outputLimitExceeded
      || result.stdoutTruncated
      || result.stderrTruncated) return '';
    return String(result.stdout || '').trim();
  }

  async function successfulText(executable, argv, options = {}) {
    return processText(await runSystem(executable, argv, options));
  }

  async function serviceManagerState(options = {}) {
    if (platform === 'darwin') {
      const uid = await successfulText('id', ['-u'], options);
      if (!/^\d+$/.test(uid)) return Object.freeze({});
      const launchdInfo = await successfulText(
        'launchctl',
        ['print', `gui/${uid}/ai.openclaw.gateway`],
        options,
      );
      if (!launchdInfo) return Object.freeze({});
      const runsMatch = launchdInfo.match(/runs = (\d+)/);
      const pidMatch = launchdInfo.match(/pid = (\d+)/);
      const stateMatch = launchdInfo.match(/state = (running|waiting|not running)/);
      const exitCodeMatch = launchdInfo.match(/last exit code = (\d+)/);
      const service = {
        manager: 'launchd',
        runs: runsMatch ? Number.parseInt(runsMatch[1], 10) : 0,
        pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : 0,
        state: stateMatch ? stateMatch[1] : 'unknown',
        lastExitCode: exitCodeMatch ? Number.parseInt(exitCodeMatch[1], 10) : null,
      };
      if (service.pid) {
        const elapsed = await successfulText('ps', ['-p', String(service.pid), '-o', 'etime='], options);
        if (elapsed) {
          service.uptimeStr = elapsed;
          const parts = elapsed.replace(/-/g, ':').split(':').reverse().map(Number);
          service.uptimeSeconds = (parts[0] || 0)
            + (parts[1] || 0) * 60
            + (parts[2] || 0) * 3600
            + (parts[3] || 0) * 86400;
        }
      }
      return Object.freeze(service);
    }

    if (platform === 'linux') {
      const systemdInfo = await successfulText('systemctl', [
        'show',
        'openclaw-gateway',
        '--property=NRestarts,ActiveState,SubState,ExecMainPID,ExecMainStartTimestamp',
      ], options);
      if (!systemdInfo) return Object.freeze({});
      const properties = {};
      for (const line of systemdInfo.split('\n')) {
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      return Object.freeze({
        manager: 'systemd',
        nRestarts: Number.parseInt(properties.NRestarts, 10) || 0,
        state: properties.ActiveState || 'unknown',
        subState: properties.SubState || 'unknown',
        pid: Number.parseInt(properties.ExecMainPID, 10) || 0,
      });
    }

    return Object.freeze({});
  }

  async function readFileTail(path, { maxLines, maxBytes = 1024 * 1024 } = {}) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new TypeError('path must be a non-empty string without NUL bytes');
    }
    if (!Number.isSafeInteger(maxLines) || maxLines <= 0) {
      throw new TypeError('maxLines must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive safe integer');
    }
    if (typeof fs.open !== 'function') {
      throw new TypeError('fs must provide an open function');
    }

    let handle;
    try {
      handle = await fs.open(path, 'r');
      const fileStat = await handle.stat();
      const length = Math.min(fileStat.size, maxBytes);
      const offset = Math.max(0, fileStat.size - length);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      let text = new TextDecoder().decode(buffer.subarray(0, bytesRead));
      let truncated = offset > 0;
      if (offset > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }
      const lines = text.replace(/\n$/, '').split('\n');
      if (lines.length > maxLines) truncated = true;
      text = lines.slice(-maxLines).join('\n');
      return Object.freeze({ text, truncated, errorCode: null, errorSummary: null });
    } catch (error) {
      return Object.freeze({
        text: '',
        truncated: false,
        errorCode: error?.code ?? null,
        errorSummary: error?.message ?? String(error),
      });
    } finally {
      try {
        await handle?.close();
      } catch {
        // A primary read result or failure remains authoritative.
      }
    }
  }

  const versionArgv = Object.freeze(['--version']);
  const gatewayStatusArgv = Object.freeze(['gateway', 'status']);

  return Object.freeze({
    findExecutable,
    invoke,
    version(options = {}) {
      return invoke(versionArgv, options);
    },
    gatewayStatus(options = {}) {
      return invoke(gatewayStatusArgv, options);
    },
    async gatewayStatusText(options = {}) {
      return processText(await invoke(gatewayStatusArgv, options));
    },
    npmVersion(options = {}) {
      return successfulText('npm', ['--version'], options);
    },
    gatewayProcesses(options = {}) {
      return successfulText('pgrep', ['-f', 'openclaw.*gateway'], options);
    },
    serviceManagerState,
    readFileTail,
  });
}

export const openClawAdapter = createOpenClawAdapter();
export const findOpenClawExecutable = openClawAdapter.findExecutable;
export const getOpenClawVersion = openClawAdapter.version;
export const getOpenClawGatewayStatus = openClawAdapter.gatewayStatus;
