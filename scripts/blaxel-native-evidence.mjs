#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { assertCommandResult, parseJsonOutput } from './blaxel-contracts.mjs';

const LAB_NAME = process.env.BLAXEL_LAB_NAME || 'clawfix-openclaw-lab';
const commands = [
  ['config-validation', 'openclaw config validate --json'],
  ['status', 'openclaw status --json'],
  ['security-audit', 'openclaw security audit --json'],
  ['policy', 'openclaw policy check --json'],
];

export async function main() {
  const { SandboxInstance } = await import('@blaxel/core');
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
    assertCommandResult(`native-${name}`, result);
    evidence.push({
      name,
      exitCode: result.exitCode,
      json: parseJsonOutput(`native-${name}`, result.stdout),
      stderr: String(result.stderr || '').trim().slice(0, 2000),
    });
  }

  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Blaxel native evidence error: ${error.message}`);
    process.exitCode = 1;
  });
}
