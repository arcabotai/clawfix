#!/usr/bin/env node

import { SandboxInstance } from '@blaxel/core';

const LAB_NAME = process.env.BLAXEL_LAB_NAME || 'clawfix-openclaw-lab';
const GATEWAY_COMMAND = 'openclaw gateway --port 18789 --verbose';

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function exec(sandbox, name, command, options = {}) {
  return sandbox.process.exec({
    name,
    command,
    workingDir: options.workingDir || '/app',
    waitForCompletion: options.waitForCompletion ?? true,
    waitForPorts: options.waitForPorts,
    keepAlive: options.keepAlive,
    timeout: options.timeout || 180,
    restartOnFailure: false,
  });
}

async function startGateway(sandbox) {
  return exec(sandbox, 'openclaw-gateway', GATEWAY_COMMAND, {
    waitForCompletion: false,
    waitForPorts: [18789],
    keepAlive: true,
    timeout: 0,
  });
}

async function stopProcess(sandbox, name) {
  try {
    await sandbox.process.kill(name);
  } catch {
    // The scenario may start from an already-stopped process.
  }
}

async function collectClawFix(sandbox, name) {
  const result = await exec(
    sandbox,
    name,
    'node cli/bin/clawfix.js --dry-run --json',
    { workingDir: '/app/clawfix', timeout: 240 },
  );
  const output = stripAnsi(result.stdout);
  try {
    const parsed = JSON.parse(output);
    if (parsed.ok && Array.isArray(parsed.issues)) {
      return {
        exitCode: result.exitCode,
        issueCount: parsed.issues.length,
        issues: parsed.issues.map(issue => ({
          severity: issue.severity,
          message: issue.text,
        })),
      };
    }
  } catch {
    // Public releases before structured --json mode use formatted output.
  }
  const issueCount = Number.parseInt(output.match(/Found (\d+) issue/)?.[1] || '0', 10);
  const issues = [...output.matchAll(/^\s+(?:❌|⚠️) \[([A-Z]+)] (.+)$/gm)]
    .map(match => ({ severity: match[1].toLowerCase(), message: match[2].trim() }));

  return { exitCode: result.exitCode, issueCount, issues };
}

async function collectDoctor(sandbox, name) {
  const result = await exec(
    sandbox,
    name,
    'openclaw doctor --lint --json --skip core/doctor/skills-readiness --no-workspace-suggestions',
  );
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      exitCode: result.exitCode,
      checksRun: parsed.checksRun,
      findings: parsed.findings?.map(finding => ({
        checkId: finding.checkId,
        severity: finding.severity,
        message: finding.message,
        path: finding.path || null,
      })) || [],
    };
  } catch {
    return { exitCode: result.exitCode, checksRun: 0, findings: [], parseError: true };
  }
}

async function invalidConfig(sandbox) {
  await exec(
    sandbox,
    'fault-config-backup',
    'cp ~/.openclaw/openclaw.json /tmp/openclaw.json.clawfix-good',
  );

  try {
    await exec(
      sandbox,
      'fault-config-inject',
      "jq '.gateway.clawfixInvalidProbe = true' ~/.openclaw/openclaw.json > /tmp/openclaw.invalid && mv /tmp/openclaw.invalid ~/.openclaw/openclaw.json",
    );
    const validate = await exec(sandbox, 'fault-config-validate', 'openclaw config validate');
    return {
      scenario: 'invalid-config',
      validate: {
        exitCode: validate.exitCode,
        output: stripAnsi(`${validate.stdout}\n${validate.stderr}`).trim().slice(0, 2000),
      },
      doctor: await collectDoctor(sandbox, 'fault-config-doctor'),
      clawfix: await collectClawFix(sandbox, 'fault-config-clawfix'),
    };
  } finally {
    await exec(
      sandbox,
      'fault-config-restore',
      'cp /tmp/openclaw.json.clawfix-good ~/.openclaw/openclaw.json',
    );
  }
}

async function deadGateway(sandbox) {
  await stopProcess(sandbox, 'openclaw-gateway');
  try {
    return {
      scenario: 'dead-gateway',
      doctor: await collectDoctor(sandbox, 'fault-dead-doctor'),
      clawfix: await collectClawFix(sandbox, 'fault-dead-clawfix'),
    };
  } finally {
    await startGateway(sandbox);
  }
}

async function portConflict(sandbox) {
  await stopProcess(sandbox, 'openclaw-gateway');
  await exec(
    sandbox,
    'fault-port-owner',
    'node -e "require(\'node:http\').createServer((q,s)=>s.end(\'occupied\')).listen(18789,\'127.0.0.1\')"',
    { waitForCompletion: false, waitForPorts: [18789], keepAlive: true, timeout: 0 },
  );

  try {
    const startup = await exec(
      sandbox,
      'fault-port-gateway-attempt',
      GATEWAY_COMMAND,
      { timeout: 60 },
    );
    return {
      scenario: 'port-conflict',
      gatewayAttempt: {
        exitCode: startup.exitCode,
        output: stripAnsi(`${startup.stdout}\n${startup.stderr}`).trim().slice(0, 3000),
      },
      doctor: await collectDoctor(sandbox, 'fault-port-doctor'),
      clawfix: await collectClawFix(sandbox, 'fault-port-clawfix'),
    };
  } finally {
    await stopProcess(sandbox, 'fault-port-owner');
    await startGateway(sandbox);
  }
}

async function main() {
  const requested = process.argv[2] || 'all';
  const sandbox = await SandboxInstance.get(LAB_NAME);
  const scenarios = {
    'invalid-config': invalidConfig,
    'dead-gateway': deadGateway,
    'port-conflict': portConflict,
  };

  const selected = requested === 'all' ? Object.values(scenarios) : [scenarios[requested]];
  if (selected.some(item => typeof item !== 'function')) {
    throw new Error(`Unknown scenario: ${requested}`);
  }

  const results = [];
  for (const scenario of selected) results.push(await scenario(sandbox));
  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
  console.error(`Blaxel scenario error: ${error.message}`);
  process.exitCode = 1;
});
