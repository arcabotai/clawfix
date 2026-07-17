#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { assertCommandResult } from './blaxel-contracts.mjs';

const LAB_NAME = process.env.BLAXEL_LAB_NAME || 'clawfix-openclaw-lab';
const OPENCLAW_VERSION = process.env.OPENCLAW_LAB_VERSION || '2026.6.11';
const REPOSITORY_URL = 'https://github.com/arcabotai/clawfix.git';

function optionValue(name) {
  const equals = process.argv.find(argument => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredCommitRef() {
  const value = optionValue('--ref') || process.env.CLAWFIX_LAB_REF;
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('provision requires an exact 40-character commit via --ref <sha> or CLAWFIX_LAB_REF');
  }
  return value.toLowerCase();
}

if (!/^(?:latest|\d{4}\.\d+\.\d+)$/.test(OPENCLAW_VERSION)) {
  throw new Error('OPENCLAW_LAB_VERSION must be "latest" or a YYYY.M.P release');
}

async function createLab() {
  const { SandboxInstance } = await import('@blaxel/core');
  return SandboxInstance.createIfNotExists({
    name: LAB_NAME,
    image: 'blaxel/base-image:latest',
    memory: 4096,
    region: process.env.BL_REGION || 'us-pdx-1',
    ports: [
      { name: 'clawfix', target: 3001, protocol: 'HTTP' },
      { name: 'openclaw', target: 18789, protocol: 'HTTP' },
    ],
    envs: [{ name: 'SANDBOX_DISABLE_PROCESS_LOGGING', value: 'true' }],
    labels: { project: 'clawfix', purpose: 'openclaw-break-fix-lab' },
    ttl: '168h',
  });
}

async function run(sandbox, name, command, options = {}) {
  const result = await sandbox.process.exec({
    name,
    command,
    workingDir: options.workingDir || '/app',
    waitForCompletion: true,
    timeout: options.timeout ?? 600,
    restartOnFailure: false,
  });
  assertCommandResult(name, result, { allowedExitCodes: options.allowedExitCodes });
  if (result.stdout?.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
  if (result.stderr?.trim()) process.stderr.write(`${result.stderr.trim()}\n`);
  return result;
}

async function provision(sandbox, expectedHead) {
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
    'checkout-clawfix-commit',
    [
      `if [ ! -d /app/clawfix/.git ]; then git clone --no-checkout ${REPOSITORY_URL} /app/clawfix; fi`,
      `git -C /app/clawfix remote set-url origin ${REPOSITORY_URL}`,
      `git -C /app/clawfix fetch --force --no-tags origin ${expectedHead}`,
      'git -C /app/clawfix checkout --detach --force FETCH_HEAD',
    ].join(' && '),
    { timeout: 300 },
  );
  const head = await run(
    sandbox,
    'verify-clawfix-commit',
    'git rev-parse HEAD',
    { workingDir: '/app/clawfix' },
  );
  const actualHead = String(head.stdout || '').trim().toLowerCase();
  if (actualHead !== expectedHead) {
    throw new Error(`expected HEAD ${expectedHead}, received ${actualHead || '<empty>'}`);
  }
  await run(
    sandbox,
    'install-clawfix',
    'npm ci --omit=dev',
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

export async function main() {
  const command = process.argv[2] || 'status';
  if (command === '--help' || command === '-h') {
    console.log('Usage: node scripts/blaxel-lab.mjs provision --ref <40-char-commit>\n       CLAWFIX_LAB_REF=<40-char-commit> npm run lab:provision');
    return;
  }
  const expectedHead = command === 'provision' ? requiredCommitRef() : null;
  const sandbox = await createLab();

  if (command === 'create') return status(sandbox);
  if (command === 'provision') {
    await provision(sandbox, expectedHead);
    return status(sandbox);
  }
  if (command === 'status') return status(sandbox);
  if (command === 'stop') {
    await stopLab(sandbox);
    return status(sandbox);
  }
  throw new Error(`Unknown command: ${command}. Use create, provision, status, or stop.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Blaxel lab error: ${error.message}`);
    process.exitCode = 1;
  });
}
