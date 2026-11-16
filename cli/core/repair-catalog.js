// ClawFix Task 6: repair catalog — the single source of truth for what an executable repair
// actually does. Each entry is the full contract the repair engine drives a repair through:
//
//   preflight(ctx) -> { ok, reason?, evidence }   — is this repair still applicable right now?
//   preview(ctx)   -> { steps: string[] }         — describe the plan; must have NO side effects.
//   apply(ctx)     -> { ... }                     — perform the repair via injected adapters only.
//   verify(ctx)    -> { ok, evidence }             — re-check *runtime* evidence, never title text.
//   rollback(ctx, { applyResult }) -> { rolledBack, note }
//
// `ctx` carries the adapters a repair is allowed to touch — never a raw shell string. For
// gateway-not-running, ctx.openclaw is the OpenClaw process boundary (cli/adapters/openclaw.js),
// which itself only ever spawns argv arrays (shell: false). ctx.wait is an injectable delay hook
// so tests can drive apply -> verify without real timers.

import { copyFile, lstat, readFile, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

import {
  DOCTOR_INVOCATION_TIMEOUT_MS,
  DOCTOR_KILL_GRACE_MS,
  DOCTOR_KILL_SIGNALS,
  assessLockHolder,
  stateLockRecoveryAllowed,
} from '../bin/security.js';
import { applyFailureReason } from './repair-engine.js';

const boundedDoctorOptions = Object.freeze({
  timeoutMs: DOCTOR_INVOCATION_TIMEOUT_MS,
  killSignals: DOCTOR_KILL_SIGNALS,
  killGraceMs: DOCTOR_KILL_GRACE_MS,
  killProcessGroup: true,
});

async function restoreGatewayAfterDoctor(openclaw, gatewayPort, wasRunning) {
  if (wasRunning !== true || typeof openclaw.gatewayListening !== 'function') return null;
  const port = Number.isInteger(gatewayPort) ? gatewayPort : 18789;
  const stillRunning = await openclaw.gatewayListening(port, { timeoutMs: 5_000 });
  if (stillRunning !== false) return true;
  await openclaw.invoke(['gateway', 'restart'], { timeoutMs: 60_000 });
  return await openclaw.gatewayListening(port, { timeoutMs: 5_000 }) === true;
}

/**
 * Preserve the process adapter's complete terminal verdict without retaining command output or
 * raw Error objects in repair/session state. The repair engine must see every failure marker;
 * projecting only `status` lets a status-zero timeout, abort, signal, or truncated result pass.
 */
function terminalResult(result, details = {}) {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const flag = (field) => (Object.hasOwn(source, field) ? source[field] : false);
  const projected = {
    status: source.status,
    signal: source.signal ?? null,
    timedOut: flag('timedOut'),
    aborted: flag('aborted'),
    stdoutTruncated: flag('stdoutTruncated'),
    stderrTruncated: flag('stderrTruncated'),
    outputLimitExceeded: flag('outputLimitExceeded'),
    errorCode: source.errorCode ?? null,
    errorSummary: source.errorSummary ?? null,
    error: source.error == null ? null : true,
  };
  for (const field of ['partial', 'partiallyApplied']) {
    if (Object.hasOwn(source, field)) projected[field] = source[field];
  }
  return Object.freeze({ ...projected, ...details });
}

/**
 * Is the gateway actually up?
 *
 * The answer is the listening port. Two weaker signals were previously treated as proof and
 * both were wrong on a real install:
 *
 *  - `pgrep -f 'openclaw.*gateway'` matched ClawFix's own `openclaw gateway status` probe (run
 *    concurrently with it, right here) and never matched a real gateway, whose argv is just
 *    `openclaw`. verify() therefore returned ok with nothing listening on the port, which is
 *    how a repair that did nothing could be reported as applied.
 *  - the `/running.*pid|state active/i` test against status prose never fired on the real
 *    `openclaw gateway status` output at all.
 *
 * Status text and PIDs are still collected, as evidence for the caller — never as the verdict.
 */
async function checkGatewayRunning(ctx) {
  const { openclaw } = ctx;
  const port = Number.isInteger(ctx.gatewayPort) ? ctx.gatewayPort : 18789;
  const [statusText, pid, listening] = await Promise.all([
    openclaw.gatewayStatusText({ timeoutMs: 5000 }),
    typeof openclaw.gatewayProcesses === 'function'
      ? openclaw.gatewayProcesses({ timeoutMs: 5000 })
      : Promise.resolve(''),
    typeof openclaw.gatewayListening === 'function'
      ? openclaw.gatewayListening(port, { timeoutMs: 5000 })
      : Promise.resolve(null),
  ]);

  // Without a port probe, fall back to filtered PIDs rather than claiming knowledge.
  const running = listening === null ? Boolean(pid) : Boolean(listening);
  return Object.freeze({
    running,
    listening: listening === null ? null : Boolean(listening),
    port,
    statusText: statusText || '',
    pid: pid || '',
  });
}

const gatewayNotRunning = Object.freeze({
  id: 'gateway-not-running',
  title: 'Restart the OpenClaw gateway',
  description: 'The OpenClaw gateway process is not running. Restart it via the OpenClaw CLI.',
  risk: 'low',

  async preflight(ctx) {
    const evidence = await checkGatewayRunning(ctx);
    if (evidence.running) {
      return Object.freeze({ ok: false, reason: 'gateway_already_running', evidence });
    }
    return Object.freeze({ ok: true, evidence });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Invoke `openclaw gateway restart` through the OpenClaw process adapter (argv, no shell).',
        'Wait briefly for the gateway to come up.',
        'Re-check gateway process/port evidence to confirm recovery.',
      ]),
    });
  },

  async apply(ctx) {
    const { openclaw } = ctx;
    const result = await openclaw.invoke(['gateway', 'restart'], { timeoutMs: 60_000 });
    return terminalResult(result);
  },

  async verify(ctx) {
    if (typeof ctx.wait === 'function') await ctx.wait(3000);
    const evidence = await checkGatewayRunning(ctx);
    return Object.freeze({ ok: evidence.running, evidence });
  },

  async rollback() {
    return Object.freeze({
      rolledBack: false,
      note: 'Gateway restart has no config/state to revert; run `openclaw gateway stop` manually if this restart was unwanted.',
    });
  },
});

/** Normalized truthiness of an `openclaw config get` result. '' means unset or unreadable. */
function configFlag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function configValue(read) {
  if (!read || read.ok !== true || typeof read.value !== 'string') return null;
  return read.value;
}

/**
 * A repair that flips one boolean OpenClaw config key to `target`.
 *
 * Every step goes through the OpenClaw CLI as argv — read the current value, set it, read it
 * back. Verification is the read-back, so a `config set` that reported success but changed
 * nothing still fails. A key OpenClaw cannot report is refused rather than assumed: unreadable
 * is not the same as false.
 */
function configToggleRepair({ id, key, target, title, description, blockedReason, risk = 'low' }) {
  const targetText = String(target);
  const previousText = String(!target);

  return Object.freeze({
    id,
    key,
    title,
    description,
    risk,

    async preflight(ctx) {
      const read = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const current = configValue(read);
      const flag = configFlag(current);
      if (flag === null) {
        return Object.freeze({
          ok: false,
          reason: 'config_state_unknown',
          evidence: { key, current: current ?? '', errorSummary: read?.errorSummary ?? null },
        });
      }
      if (flag === target) {
        return Object.freeze({ ok: false, reason: blockedReason, evidence: { key, current } });
      }
      return Object.freeze({ ok: true, evidence: { key, current } });
    },

    async preview() {
      return Object.freeze({
        steps: Object.freeze([
          `Read ${key} through the OpenClaw CLI (argv, no shell).`,
          `Set ${key} to ${targetText}.`,
          'Read it back to confirm the change actually landed.',
        ]),
        summary: `openclaw config set ${key} ${targetText}`,
      });
    },

    async apply(ctx) {
      const result = await ctx.openclaw.configSet(key, targetText, { timeoutMs: 30_000 });
      const failure = applyFailureReason(result);
      return terminalResult(result, {
        changed: failure === null ? true : 'unknown',
        changes: failure === null
          ? Object.freeze([Object.freeze({ type: 'config', key, before: previousText, after: targetText })])
          : Object.freeze([]),
      });
    },

    async verify(ctx) {
      const read = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const current = configValue(read);
      return Object.freeze({
        ok: configFlag(current) === target,
        evidence: { key, current: current ?? '', errorSummary: read?.errorSummary ?? null },
      });
    },

    async rollback(ctx) {
      const result = await ctx.openclaw.configSet(key, previousText, { timeoutMs: 30_000 });
      if (result.status !== 0) {
        return Object.freeze({
          rolledBack: false,
          note: `Could not restore ${key}; check \`openclaw config get ${key}\`.`,
        });
      }
      const read = await ctx.openclaw.configGet(key, { timeoutMs: 10_000 });
      const current = configValue(read);
      const restored = configFlag(current) === !target;
      return Object.freeze({
        rolledBack: restored,
        note: restored
          ? `Restored ${key} to ${previousText}.`
          : read?.ok === true
            ? `Rollback command completed but ${key} was not restored to ${previousText}.`
            : `Rollback command completed but ${key} could not be read back: `
              + `${read?.errorSummary ?? 'unknown read failure'}.`,
      });
    },
  });
}

const autoUpdateEnabled = configToggleRepair({
  id: 'auto-update-enabled-warning',
  key: 'update.auto.enabled',
  target: false,
  title: 'Disable OpenClaw auto-update',
  description:
    'Auto-update restarts the gateway on its own schedule, which is the documented cause of '
    + 'restart loops. This turns it off; updates then happen when you run them.',
  blockedReason: 'auto_update_already_disabled',
});

const memoryFlushDisabled = configToggleRepair({
  id: 'no-memory-flush',
  key: 'agents.defaults.compaction.memoryFlush.enabled',
  target: true,
  title: 'Enable memory flush on compaction',
  description:
    'Without a memory flush, anything the agent has not written down is lost when the context '
    + 'is compacted. This makes compaction persist memory first.',
  blockedReason: 'memory_flush_already_enabled',
});

const gatewayLoopbackNoAuth = Object.freeze({
  id: 'gateway-loopback-no-auth',
  title: 'Require a token on the gateway',
  description:
    'The gateway accepts unauthenticated connections. This switches auth to token mode, reuses '
    + 'an existing token or has OpenClaw generate one when missing, and verifies token presence '
    + 'without recording the token. Clients will need that token to connect afterwards.',
  // Medium, not low: existing clients stop working until they carry the new token.
  risk: 'medium',

  async preflight(ctx) {
    const read = await ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 });
    const mode = configValue(read);
    const current = String(mode ?? '').trim().toLowerCase();
    if (mode === null || current === '') {
      return Object.freeze({
        ok: false,
        reason: 'config_state_unknown',
        evidence: { mode: current, errorSummary: read?.errorSummary ?? null },
      });
    }
    if (current === 'token' || current === 'password' || current === 'trusted-proxy') {
      return Object.freeze({ ok: false, reason: 'gateway_auth_already_enabled', evidence: { mode: current } });
    }
    if (current !== 'none') {
      return Object.freeze({ ok: false, reason: 'config_state_unknown', evidence: { mode: current } });
    }
    return Object.freeze({ ok: true, evidence: { mode: current } });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Check whether gateway.auth.token is present without recording its value.',
        'Set gateway.auth.mode to token through the OpenClaw CLI (argv, no shell).',
        'If no token exists, run `openclaw doctor --fix --generate-gateway-token` so OpenClaw generates one. That doctor invocation is limited to 120 seconds, is killed with SIGTERM and then SIGKILL, and is not run again.',
        'If the gateway was running before that doctor command and is stopped after it, restart the gateway once.',
        'Read gateway.auth.mode and token presence back to confirm token auth is usable.',
        'Restart the gateway yourself for it to take effect; existing clients need the new token.',
      ]),
      summary: 'verify/generate gateway token + openclaw config set gateway.auth.mode token',
    });
  },

  async apply(ctx) {
    const changes = [];
    const tokenBefore = await ctx.openclaw.configHasValue(
      'gateway.auth.token',
      { timeoutMs: 10_000 },
    );
    if (!tokenBefore.ok) {
      return terminalResult(tokenBefore, {
        stage: 'read-token-state',
        changed: false,
        changes: Object.freeze(changes),
        errorSummary: tokenBefore.errorSummary || 'could not determine gateway token presence',
      });
    }
    const set = await ctx.openclaw.configSet('gateway.auth.mode', 'token', { timeoutMs: 30_000 });
    if (applyFailureReason(set) !== null) {
      return terminalResult(set, {
        stage: 'set-mode',
        changed: 'unknown',
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: tokenBefore.present,
        tokenMayHaveChanged: false,
      });
    }
    changes.push(Object.freeze({
      type: 'config',
      key: 'gateway.auth.mode',
      before: 'none',
      after: 'token',
    }));
    if (tokenBefore.present) {
      return terminalResult(set, {
        stage: 'set-mode',
        changed: true,
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: true,
        tokenMayHaveChanged: false,
      });
    }
    const port = Number.isInteger(ctx.gatewayPort) ? ctx.gatewayPort : 18789;
    let wasRunning = null;
    if (typeof ctx.openclaw.gatewayListening === 'function') {
      wasRunning = await ctx.openclaw.gatewayListening(port, { timeoutMs: 5_000 });
    }
    let generated;
    try {
      generated = await ctx.openclaw.invoke(
        ['doctor', '--fix', '--generate-gateway-token'],
        boundedDoctorOptions,
      );
    } catch (error) {
      await restoreGatewayAfterDoctor(ctx.openclaw, port, wasRunning);
      return terminalResult(null, {
        stage: 'generate-token',
        changed: true,
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: false,
        tokenMayHaveChanged: true,
        errorSummary: error.message,
        error: true,
      });
    }
    const gatewayRestored = await restoreGatewayAfterDoctor(ctx.openclaw, port, wasRunning);
    if (wasRunning === true && gatewayRestored === false) {
      return terminalResult(generated, {
        stage: 'generate-token',
        changed: true,
        changes: Object.freeze(changes),
        tokenPreviouslyPresent: false,
        tokenMayHaveChanged: true,
        gatewayRestored: false,
        errorSummary: 'Gateway was running before doctor and was left stopped',
        error: true,
      });
    }
    return terminalResult(generated, {
      stage: 'generate-token',
      changed: true,
      changes: Object.freeze(changes),
      tokenPreviouslyPresent: false,
      tokenMayHaveChanged: true,
      ...(wasRunning === true ? { gatewayRestored: true } : {}),
    });
  },

  // Presence is the strongest safe local assertion: a client authentication round trip would
  // require handling token material, so end-to-end token usability remains an external OpenClaw
  // semantic rather than evidence retained by ClawFix.
  async verify(ctx) {
    const [modeRead, tokenState] = await Promise.all([
      ctx.openclaw.configGet('gateway.auth.mode', { timeoutMs: 10_000 }),
      ctx.openclaw.configHasValue('gateway.auth.token', { timeoutMs: 10_000 }),
    ]);
    const mode = String(configValue(modeRead) ?? '').trim();
    return Object.freeze({
      ok: modeRead?.ok === true
        && mode.toLowerCase() === 'token'
        && tokenState.ok === true
        && tokenState.present === true,
      evidence: {
        mode,
        tokenPresent: tokenState.ok === true ? tokenState.present : null,
        errorSummary: modeRead?.errorSummary ?? tokenState.errorSummary ?? null,
      },
    });
  },

  async rollback(ctx, { applyResult } = {}) {
    if (!applyResult?.changed) {
      return Object.freeze({ rolledBack: false, note: 'Auth mode was never changed.' });
    }
    const setMode = await ctx.openclaw.configSet(
      'gateway.auth.mode',
      'none',
      { timeoutMs: 30_000 },
    );
    if (setMode.status !== 0) {
      return Object.freeze({
        rolledBack: false,
        note: 'Could not restore gateway.auth.mode; inspect it before restarting the gateway.',
      });
    }
    const modeRead = await ctx.openclaw.configGet(
      'gateway.auth.mode',
      { timeoutMs: 10_000 },
    );
    const mode = String(configValue(modeRead) ?? '').trim().toLowerCase();
    if (modeRead?.ok !== true || mode !== 'none') {
      return Object.freeze({
        rolledBack: false,
        note: modeRead?.ok === true
          ? `Rollback command completed but gateway.auth.mode is ${mode || '(empty)'}, not none.`
          : 'Rollback command completed but gateway.auth.mode could not be read back: '
            + `${modeRead?.errorSummary ?? 'unknown read failure'}.`,
      });
    }

    if (applyResult.tokenPreviouslyPresent === false && applyResult.tokenMayHaveChanged) {
      const unset = await ctx.openclaw.configUnset(
        'gateway.auth.token',
        { timeoutMs: 30_000 },
      );
      if (unset.status !== 0) {
        return Object.freeze({
          rolledBack: false,
          note: 'Restored gateway.auth.mode to none, but could not remove the token this repair may have generated.',
        });
      }
      const tokenState = await ctx.openclaw.configHasValue(
        'gateway.auth.token',
        { timeoutMs: 10_000 },
      );
      if (!tokenState.ok || tokenState.present) {
        return Object.freeze({
          rolledBack: false,
          note: tokenState.ok
            ? 'Restored gateway.auth.mode to none, but the generated token is still present.'
            : 'Restored gateway.auth.mode to none, but token absence could not be verified: '
              + `${tokenState.errorSummary ?? 'unknown read failure'}.`,
        });
      }
    }

    return Object.freeze({
      rolledBack: true,
      note: applyResult.tokenPreviouslyPresent === false && applyResult.tokenMayHaveChanged
        ? 'Restored gateway.auth.mode to none and verified the generated token was removed.'
        : 'Restored gateway.auth.mode to its previous value, none.',
    });
  },
});

const pluginsInstallsUnrecognized = Object.freeze({
  id: 'plugins-installs-unrecognized',
  title: 'Remove empty plugins.installs',
  description:
    'plugins.installs is not a valid plugins key. An empty object is removed after a config '
    + 'backup and checked with openclaw config validate. Populated install records are not deleted.',
  risk: 'low',

  async preflight(ctx) {
    const read = await ctx.openclaw.configGet('plugins.installs', { timeoutMs: 10_000 });
    if (!read?.ok) {
      return Object.freeze({
        ok: false,
        reason: 'plugins_installs_absent',
        evidence: { errorSummary: read?.errorSummary ?? null },
      });
    }
    if (String(read.value ?? '').trim() !== '{}') {
      return Object.freeze({
        ok: false,
        reason: 'plugins_installs_not_empty',
        evidence: { empty: false },
      });
    }
    return Object.freeze({ ok: true, evidence: { empty: true } });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Copy openclaw.json to a timestamped backup.',
        'Remove only plugins.installs through openclaw config unset (argv, no shell).',
        'Run openclaw config validate --json when that command returns a verdict.',
        'Restore the backup if validation fails.',
      ]),
    });
  },

  async apply(ctx) {
    if (typeof ctx.backupConfig !== 'function') {
      return terminalResult(null, {
        changed: false,
        error: true,
        errorSummary: 'config backup is unavailable',
      });
    }
    let backup;
    try {
      backup = await ctx.backupConfig();
    } catch (error) {
      return terminalResult(null, {
        changed: false,
        error: true,
        errorSummary: error.message,
      });
    }
    if (!backup?.ok || typeof backup.path !== 'string' || backup.path.length === 0) {
      return terminalResult(null, {
        changed: false,
        error: true,
        errorSummary: 'config backup failed',
      });
    }
    const removed = await ctx.openclaw.configUnset('plugins.installs', { timeoutMs: 30_000 });
    if (applyFailureReason(removed) !== null) {
      return terminalResult(removed, {
        changed: false,
        backupPath: backup.path,
        stage: 'unset',
      });
    }
    if (typeof ctx.openclaw.configValidate === 'function') {
      const validation = await ctx.openclaw.configValidate({ timeoutMs: 30_000 });
      if (validation?.available === true && validation.valid === false) {
        if (typeof ctx.restoreConfig === 'function') {
          await ctx.restoreConfig({ path: backup.path });
        }
        return terminalResult(null, {
          changed: false,
          backupPath: backup.path,
          restored: true,
          error: true,
          errorSummary: 'openclaw config validate rejected the edited config',
        });
      }
    }
    return terminalResult(removed, {
      changed: true,
      backupPath: backup.path,
      stage: 'unset',
    });
  },

  async verify(ctx) {
    const read = await ctx.openclaw.configGet('plugins.installs', { timeoutMs: 10_000 });
    const value = String(read?.value ?? '').trim();
    const gone = read?.ok !== true || value === '' || value === 'null';
    return Object.freeze({
      ok: gone && value !== '{}',
      evidence: { present: read?.ok === true && value === '{}', errorSummary: read?.errorSummary ?? null },
    });
  },

  async rollback(ctx, { applyResult } = {}) {
    if (typeof applyResult?.backupPath !== 'string' || typeof ctx.restoreConfig !== 'function') {
      return Object.freeze({
        rolledBack: false,
        note: 'No config backup was recorded, so plugins.installs was not restored.',
      });
    }
    const restored = await ctx.restoreConfig({ path: applyResult.backupPath });
    return Object.freeze({
      rolledBack: restored?.ok === true,
      note: restored?.ok === true
        ? 'Restored openclaw.json from the backup taken before plugins.installs was removed.'
        : 'Could not restore the config backup.',
    });
  },
});

const LOCK_BACKUP_SUFFIX = '.clawfix-bak';
const defaultLockFs = Object.freeze({ copyFile, lstat, readFile, readdir, unlink });

function lockFs(ctx) {
  return ctx?.fs && typeof ctx.fs.readdir === 'function' ? ctx.fs : defaultLockFs;
}

function insideDir(root, candidate) {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
}

function pidFromLockText(text) {
  const match = String(text ?? '').match(/"pid"\s*:\s*(\d{1,10})/);
  const pid = Number(match?.[1]);
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2_147_483_647 ? pid : null;
}

async function collectStateLockFiles(root, fsApi) {
  const found = [];
  const pending = [{ dir: root, depth: 0 }];
  const seen = new Set();
  while (pending.length > 0 && found.length < 32) {
    const current = pending.shift();
    if (!current || seen.has(current.dir) || current.depth > 6) continue;
    seen.add(current.dir);
    let names = [];
    try {
      names = await fsApi.readdir(current.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(current.dir, String(name));
      if (!insideDir(root, full)) continue;
      let info;
      try {
        info = await fsApi.lstat(full);
      } catch {
        continue;
      }
      if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) continue;
      if (typeof info.isDirectory === 'function' && info.isDirectory()) {
        pending.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (typeof info.isFile !== 'function' || !info.isFile()) continue;
      if (!String(name).endsWith('.lock') || String(name).includes('sqlite') || String(name).endsWith(LOCK_BACKUP_SUFFIX)) continue;
      if (Number(info.size) > 65_536) continue;
      let text = '';
      try {
        text = await fsApi.readFile(full, 'utf8');
      } catch {
        continue;
      }
      found.push({ path: full, pid: pidFromLockText(text) });
    }
  }
  return found;
}

async function defaultProbeLockPid(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { signalCode: error?.code === 'ESRCH' ? 'ESRCH' : (error?.code || 'UNKNOWN'), command: null };
  }
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return { signalCode: 'OK', command: Buffer.from(raw).toString('utf8').replace(/\0/g, ' ').trim() };
  } catch {
    return { signalCode: 'OK', command: null };
  }
}

async function inspectStateLocks(ctx) {
  const stateDir = typeof ctx?.stateDir === 'string' ? ctx.stateDir : '';
  if (!isAbsolute(stateDir)) return { files: [], holders: [] };
  const files = await collectStateLockFiles(stateDir, lockFs(ctx));
  const probe = typeof ctx.probeLockPid === 'function' ? ctx.probeLockPid : defaultProbeLockPid;
  const holders = [];
  for (const file of files) {
    if (!file.pid) continue;
    const observed = await probe(file.pid);
    const holder = assessLockHolder({ pid: file.pid, ...observed });
    if (holder) holders.push(Object.freeze({ ...holder, path: file.path }));
  }
  return { files, holders };
}

async function removeLockBackups(fsApi, backups) {
  for (const item of backups) {
    if (typeof item?.backupPath === 'string' && item.backupPath.endsWith(LOCK_BACKUP_SUFFIX)) {
      try { await fsApi.unlink(item.backupPath); } catch { /* the copy may already be gone */ }
    }
  }
}

const stateLockDeadlock = Object.freeze({
  id: 'state-lock-deadlock',
  title: 'Recover a dead OpenClaw state lock',
  description:
    'Runs openclaw gateway recover-lock and the confirmation it prints, only when every lock-file '
    + 'pid is gone or reused by a non-OpenClaw command. Lock files are copied aside first. A live or '
    + 'unproven holder is refused. The state directory and SQLite files are not deleted.',
  risk: 'medium',

  async preflight(ctx) {
    const inspected = await inspectStateLocks(ctx);
    if (!stateLockRecoveryAllowed(inspected.holders)) {
      return Object.freeze({
        ok: false,
        reason: inspected.holders.some(holder => holder.status === 'alive')
          ? 'live_holder'
          : 'holder_not_proven_dead',
        evidence: Object.freeze({ holders: inspected.holders.length }),
      });
    }
    return Object.freeze({
      ok: true,
      evidence: Object.freeze({ holders: inspected.holders.length, locks: inspected.files.length }),
    });
  },

  async preview() {
    return Object.freeze({
      steps: Object.freeze([
        'Read lock files under the OpenClaw state directory and check each holder pid.',
        'Refuse the repair when any holder is alive, unreadable, or not recorded.',
        'Copy each lock file to a sibling .clawfix-bak file.',
        'Run openclaw gateway recover-lock --json, then --confirm with that fingerprint only.',
        'Restore the lock files from those copies if confirmation fails.',
      ]),
    });
  },

  async apply(ctx) {
    const inspected = await inspectStateLocks(ctx);
    if (!stateLockRecoveryAllowed(inspected.holders)) {
      return terminalResult(null, {
        changed: false,
        error: true,
        errorSummary: 'holder is not proven dead',
      });
    }
    const fsApi = lockFs(ctx);
    const backups = [];
    for (const file of inspected.files) {
      if (!file.pid) continue;
      const backupPath = `${file.path}${LOCK_BACKUP_SUFFIX}`;
      if (!insideDir(ctx.stateDir, backupPath)) {
        return terminalResult(null, {
          changed: false,
          error: true,
          errorSummary: 'lock backup path escaped the state directory',
          backups,
        });
      }
      await fsApi.copyFile(file.path, backupPath);
      backups.push({ path: file.path, backupPath });
    }
    const inspection = await ctx.openclaw.invoke(
      ['gateway', 'recover-lock', '--json'],
      { timeoutMs: 30_000 },
    );
    if (applyFailureReason(inspection) !== null) {
      return terminalResult(inspection, { changed: false, backups, stage: 'inspect' });
    }
    let parsed = null;
    try { parsed = JSON.parse(inspection.stdout); } catch { parsed = null; }
    const confirmation = parsed?.confirmation;
    if (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)) {
      return terminalResult(null, {
        changed: false,
        error: true,
        errorSummary: 'recover-lock did not return a confirmation fingerprint',
        backups,
        stage: 'inspect',
      });
    }
    const again = await inspectStateLocks(ctx);
    if (!stateLockRecoveryAllowed(again.holders)) {
      return terminalResult(null, {
        changed: false,
        error: true,
        errorSummary: 'holder changed before confirmation',
        backups,
        stage: 'inspect',
      });
    }
    const confirmed = await ctx.openclaw.invoke(
      ['gateway', 'recover-lock', '--confirm', confirmation, '--json'],
      { timeoutMs: 30_000 },
    );
    if (applyFailureReason(confirmed) !== null) {
      return terminalResult(confirmed, { changed: true, backups, stage: 'confirm' });
    }
    return terminalResult(confirmed, { changed: true, backups, stage: 'confirm' });
  },

  async verify(ctx) {
    const result = await ctx.openclaw.invoke(
      ['gateway', 'recover-lock', '--json'],
      { timeoutMs: 30_000 },
    );
    if (applyFailureReason(result) !== null) return Object.freeze({ ok: false, evidence: Object.freeze({}) });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
    return Object.freeze({
      ok: parsed?.present === false,
      evidence: Object.freeze({ present: parsed?.present === true }),
    });
  },

  async rollback(ctx, { applyResult } = {}) {
    const fsApi = lockFs(ctx);
    const backups = Array.isArray(applyResult?.backups) ? applyResult.backups : [];
    if (applyResult?.changed !== true) {
      await removeLockBackups(fsApi, backups);
      return Object.freeze({
        rolledBack: true,
        note: 'Lock files were not recovered. The backup copies were removed.',
      });
    }
    try {
      for (const item of backups) {
        if (typeof item?.path !== 'string' || typeof item?.backupPath !== 'string') continue;
        if (!item.backupPath.endsWith(LOCK_BACKUP_SUFFIX)) continue;
        if (!insideDir(ctx.stateDir, item.path) || !insideDir(ctx.stateDir, item.backupPath)) continue;
        await fsApi.copyFile(item.backupPath, item.path);
      }
    } catch (error) {
      return Object.freeze({ rolledBack: false, note: `Could not restore a lock file: ${error.message}` });
    }
    return Object.freeze({
      rolledBack: true,
      note: 'Restored lock files from the copies taken before gateway recover-lock.',
    });
  },
});

// post-upgrade-migration-crash-loop and doctor-fix-stalled are detect-only.
// doctor --fix is not a bounded repair for those shapes: it stops the gateway,
// and the reported workspace and per-agent session failures were not fixed by it.
export const repairCatalog = Object.freeze({
  'gateway-not-running': gatewayNotRunning,
  'auto-update-enabled-warning': autoUpdateEnabled,
  'gateway-loopback-no-auth': gatewayLoopbackNoAuth,
  'no-memory-flush': memoryFlushDisabled,
  'plugins-installs-unrecognized': pluginsInstallsUnrecognized,
  'state-lock-deadlock': stateLockDeadlock,
});
