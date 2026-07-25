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
