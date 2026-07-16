#!/usr/bin/env node

import { SandboxInstance } from '@blaxel/core';

const LAB_NAME = process.env.BLAXEL_LAB_NAME || 'clawfix-openclaw-lab';
const commands = [
  ['config-validation', 'openclaw config validate --json'],
  ['status', 'openclaw status --json'],
  ['security-audit', 'openclaw security audit --json'],
  ['policy', 'openclaw policy check --json'],
];

function parseJson(value) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch {
    return null;
  }
}

async function main() {
  const sandbox = await SandboxInstance.get(LAB_NAME);
  const evidence = [];

  for (const [name, command] of commands) {
    const result = await sandbox.process.exec({
      name: `native-${name}`,
      command,
      workingDir: '/app',
      waitForCompletion: true,
      timeout: 180,
      restartOnFailure: false,
    });
    evidence.push({
      name,
      exitCode: result.exitCode,
      json: parseJson(result.stdout),
      stderr: String(result.stderr || '').trim().slice(0, 2000),
    });
  }

  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => {
  console.error(`Blaxel native evidence error: ${error.message}`);
  process.exitCode = 1;
});
