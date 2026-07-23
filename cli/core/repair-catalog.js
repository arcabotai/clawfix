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

async function checkGatewayRunning(ctx) {
  const { openclaw } = ctx;
  const [statusText, pid] = await Promise.all([
    openclaw.gatewayStatusText({ timeoutMs: 5000 }),
    openclaw.gatewayProcesses({ timeoutMs: 5000 }),
  ]);
  const running = Boolean(pid) || /running.*pid|state active/i.test(statusText || '');
  return Object.freeze({ running, statusText: statusText || '', pid: pid || '' });
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
    return Object.freeze({
      status: result.status,
      timedOut: result.timedOut,
      errorSummary: result.errorSummary,
      stdout: result.stdout,
    });
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

export const repairCatalog = Object.freeze({
  'gateway-not-running': gatewayNotRunning,
});
