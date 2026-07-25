#!/usr/bin/env node
/**
 * ClawFix review lab on Blaxel.
 *
 * The repo's own scripts/blaxel-lab.mjs provisions from a pushed commit; this work is local
 * only, so this uploads the working tree instead.
 */
import { SandboxInstance } from '@blaxel/core';

const NAME = process.env.LAB_NAME || 'clawfix-review-lab';

export async function lab() {
  return SandboxInstance.createIfNotExists({
    name: NAME,
    image: 'blaxel/base-image:latest',
    memory: 8192,
    region: process.env.BL_REGION || 'us-pdx-1',
    ports: [
      { name: 'clawfix', target: 3001, protocol: 'HTTP' },
      { name: 'openclaw', target: 18789, protocol: 'HTTP' },
    ],
    envs: [{ name: 'SANDBOX_DISABLE_PROCESS_LOGGING', value: 'true' }],
    labels: { project: 'clawfix', purpose: 'review-upgrade-pass' },
    ttl: '24h',
  });
}

export async function sh(sandbox, name, command, { workingDir = '/app/clawfix', timeout = 900, allowFail = false } = {}) {
  const result = await sandbox.process.exec({
    name: `${name}-${Math.random().toString(36).slice(2, 8)}`,
    command,
    workingDir,
    waitForCompletion: true,
    timeout,
    restartOnFailure: false,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  if (!allowFail && result.exitCode !== 0) {
    throw new Error(`[${name}] exit ${result.exitCode}\n${out.slice(-4000)}`);
  }
  return { exitCode: result.exitCode, out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sandbox = await lab();
  console.log(JSON.stringify({
    name: sandbox.metadata.name,
    status: sandbox.status,
    image: sandbox.spec?.runtime?.image,
    memory: sandbox.spec?.runtime?.memory,
    expiresIn: sandbox.expiresIn,
  }, null, 2));

  const probe = await sh(sandbox, 'probe', 'uname -a; cat /etc/os-release | head -3; node --version 2>/dev/null || echo "no node"; which apk apt-get 2>/dev/null', { workingDir: '/', allowFail: true });
  console.log(probe.out);
}
