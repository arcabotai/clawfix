#!/usr/bin/env node

import { SandboxInstance } from '@blaxel/core';

const LAB_NAME = process.env.BLAXEL_LAB_NAME || 'clawfix-openclaw-lab';
const OPENCLAW_VERSION = process.env.OPENCLAW_LAB_VERSION || '2026.6.11';

if (!/^(?:latest|\d{4}\.\d+\.\d+)$/.test(OPENCLAW_VERSION)) {
  throw new Error('OPENCLAW_LAB_VERSION must be "latest" or a YYYY.M.P release');
}

async function createLab() {
  return SandboxInstance.createIfNotExists({
    name: LAB_NAME,
    image: 'blaxel/base-image:latest',
    memory: 4096,
    region: process.env.BL_REGION || 'us-pdx-1',
    ports: [
      { name: 'clawfix', target: 3001, protocol: 'HTTP' },
      { name: 'openclaw', target: 18789, protocol: 'HTTP' },
    ],
    envs: [
      { name: 'SANDBOX_DISABLE_PROCESS_LOGGING', value: 'true' },
    ],
    labels: {
      project: 'clawfix',
      purpose: 'openclaw-break-fix-lab',
    },
    ttl: '168h',
  });
}

async function run(sandbox, name, command, options = {}) {
  const result = await sandbox.process.exec({
    name,
    command,
    workingDir: options.workingDir || '/app',
    waitForCompletion: true,
    timeout: options.timeout || 600,
  });

  if (result.stdout?.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.stderr?.trim()) process.stderr.write(`${result.stderr.trim()}\n`);

  if (result.exitCode !== 0) {
    throw new Error(`${name} failed with exit code ${result.exitCode}`);
  }

  return result;
}

async function provision(sandbox) {
  await run(
    sandbox,
    'install-system-tools',
    'mkdir -p /app && apk add --no-cache bash curl jq procps lsof iproute2 coreutils git',
    { workingDir: '/', timeout: 300 },
  );
  await run(
    sandbox,
    'install-openclaw',
    `npm install --global openclaw@${OPENCLAW_VERSION}`,
    { timeout: 1200 },
  );
  await run(
    sandbox,
    'clone-clawfix',
    'if [ -d /app/clawfix/.git ]; then git -C /app/clawfix pull --ff-only; else git clone https://github.com/arcabotai/clawfix.git /app/clawfix; fi',
    { timeout: 300 },
  );
  await run(
    sandbox,
    'install-clawfix',
    'npm install --omit=dev',
    { workingDir: '/app/clawfix', timeout: 600 },
  );
  await run(
    sandbox,
    'lab-versions',
    'node --version && npm --version && openclaw --version && node cli/bin/clawfix.js --version',
    { workingDir: '/app/clawfix' },
  );
}

async function status(sandbox) {
  const processes = await sandbox.process.list();
  console.log(JSON.stringify({
    name: sandbox.metadata.name,
    status: sandbox.status,
    image: sandbox.spec.runtime?.image,
    memory: sandbox.spec.runtime?.memory,
    expiresIn: sandbox.expiresIn,
    processes: processes.map(process => ({
      name: process.name,
      status: process.status,
      exitCode: process.exitCode,
    })),
  }, null, 2));
}

async function stopLab(sandbox) {
  const processes = await sandbox.process.list();
  const retainedProcesses = new Set(['openclaw-gateway', 'fault-port-owner']);

  for (const process of processes) {
    if (retainedProcesses.has(process.name) && process.status === 'RUNNING') {
      await sandbox.process.kill(process.name);
    }
  }
}

async function main() {
  const command = process.argv[2] || 'status';
  const sandbox = await createLab();

  if (command === 'create') {
    await status(sandbox);
    return;
  }

  if (command === 'provision') {
    await provision(sandbox);
    await status(sandbox);
    return;
  }

  if (command === 'status') {
    await status(sandbox);
    return;
  }

  if (command === 'stop') {
    await stopLab(sandbox);
    await status(sandbox);
    return;
  }

  throw new Error(`Unknown command: ${command}. Use create, provision, status, or stop.`);
}

main().catch(error => {
  console.error(`Blaxel lab error: ${error.message}`);
  process.exitCode = 1;
});
