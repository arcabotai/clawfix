#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  assertCommandResult,
  assertScenarioEvidence,
  parseJsonOutput,
} from './blaxel-contracts.mjs';

const LAB_NAME = process.env.BLAXEL_LAB_NAME || 'clawfix-openclaw-lab';
const GATEWAY_COMMAND = 'openclaw gateway --port 18789 --verbose';

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function exec(sandbox, name, command, options = {}) {
  const result = await sandbox.process.exec({
    name,
    command,
    workingDir: options.workingDir || '/app',
    waitForCompletion: true,
    timeout: options.timeout ?? 180,
    restartOnFailure: false,
  });
  return assertCommandResult(name, result, { allowedExitCodes: options.allowedExitCodes });
}

async function startDetached(sandbox, name, command, waitForPorts) {
  await sandbox.process.exec({
    name,
    command,
    workingDir: '/app',
    waitForCompletion: false,
    waitForPorts,
    keepAlive: true,
    timeout: 600,
    restartOnFailure: false,
  });
  const processes = await sandbox.process.list();
  const process = processes.find(item => item.name === name);
  if (!process || process.status !== 'RUNNING') {
    throw new Error(`${name} did not reach RUNNING state`);
  }
  return process;
}

async function startGateway(sandbox) {
  return startDetached(sandbox, 'openclaw-gateway', GATEWAY_COMMAND, [18789]);
}

async function stopProcess(sandbox, name) {
  const processes = await sandbox.process.list();
  const process = processes.find(item => item.name === name);
  if (process?.status === 'RUNNING') await sandbox.process.kill(name);
  const remaining = await sandbox.process.list();
  if (remaining.some(item => item.name === name && item.status === 'RUNNING')) {
    throw new Error(`${name} remained RUNNING after stop`);
  }
}

function normalizedIssueId(issue) {
  if (issue.id || issue.nativeCheckId) return issue.id || issue.nativeCheckId;
  const text = String(issue.text || '').toLowerCase();
  if (text.includes('gateway is not running')) return 'gateway-not-running';
  if (text.includes('port conflict')) return 'port-conflict';
  return null;
}

async function collectClawFix(sandbox, name) {
  const result = await exec(
    sandbox,
    name,
    'node cli/bin/clawfix.js --dry-run --json',
    { workingDir: '/app/clawfix', timeout: 240 },
  );
  const parsed = parseJsonOutput(name, stripAnsi(result.stdout));
  if (parsed.ok !== true || !parsed.diagnostic || !Array.isArray(parsed.issues)) {
    throw new Error(`${name} returned incomplete ClawFix JSON`);
  }
  parsed.issues = parsed.issues.map(issue => ({
    ...issue,
    id: normalizedIssueId(issue),
  }));
  return parsed;
}

async function collectDoctor(sandbox, name) {
  const result = await exec(
    sandbox,
    name,
    'openclaw doctor --lint --json --skip core/doctor/skills-readiness --no-workspace-suggestions',
  );
  const parsed = parseJsonOutput(name, stripAnsi(result.stdout));
  if (!Number.isSafeInteger(parsed.checksRun) || !Array.isArray(parsed.findings)) {
    throw new Error(`${name} returned incomplete Doctor JSON`);
  }
  return {
    exitCode: result.exitCode,
    checksRun: parsed.checksRun,
    findings: parsed.findings.map(finding => ({
      checkId: finding.checkId,
      severity: finding.severity,
      message: finding.message,
      path: finding.path || null,
    })),
  };
}

async function verifyConfigRestored(sandbox, expectedChecksum) {
  const checksumResult = await exec(
    sandbox,
    'verify-config-checksum',
    "sha256sum ~/.openclaw/openclaw.json | cut -d' ' -f1",
  );
  const checksum = String(checksumResult.stdout || '').trim();
  if (!checksum || checksum !== expectedChecksum) {
    throw new Error(`config restoration checksum mismatch: expected ${expectedChecksum}, received ${checksum}`);
  }
  const validation = await exec(
    sandbox,
    'verify-restored-config',
    'openclaw config validate --json',
  );
  const parsed = parseJsonOutput('verify-restored-config', validation.stdout);
  if (parsed.valid !== true && parsed.ok !== true) {
    throw new Error('restored config did not validate successfully');
  }
  return { configChecksum: checksum, configValid: true };
}

async function verifyGatewayRestored(sandbox) {
  const result = await exec(sandbox, 'verify-restored-gateway', 'openclaw status --json');
  const parsed = parseJsonOutput('verify-restored-gateway', result.stdout);
  if (parsed.gateway?.reachable !== true) {
    throw new Error('gateway restoration did not produce a reachable gateway');
  }
  return { gatewayReachable: true };
}

async function invalidConfig(sandbox) {
  const backup = await exec(
    sandbox,
    'fault-config-backup',
    "cp ~/.openclaw/openclaw.json /tmp/openclaw.json.clawfix-good && sha256sum /tmp/openclaw.json.clawfix-good | cut -d' ' -f1",
  );
  const expectedChecksum = String(backup.stdout || '').trim();
  if (!expectedChecksum) throw new Error('fault-config-backup returned no checksum');

  let scenarioResult;
  try {
    await exec(
      sandbox,
      'fault-config-inject',
      "jq '.gateway.clawfixInvalidProbe = true' ~/.openclaw/openclaw.json > /tmp/openclaw.invalid && mv /tmp/openclaw.invalid ~/.openclaw/openclaw.json",
    );
    const validation = await exec(
      sandbox,
      'fault-config-validate',
      'openclaw config validate',
      { allowedExitCodes: [1] },
    );
    const clawfix = await collectClawFix(sandbox, 'fault-config-clawfix');
    const verifiedIssueIds = assertScenarioEvidence('invalid-config', clawfix, {
      expectedIssueIds: ['config/schema-invalid'],
      evidence: value => value.diagnostic.nativeConfig?.available === true
        && value.diagnostic.nativeConfig.valid === false,
    });
    scenarioResult = {
      scenario: 'invalid-config',
      verifiedIssueIds,
      validation: stripAnsi(`${validation.stdout}\n${validation.stderr}`).trim().slice(0, 2000),
      doctor: await collectDoctor(sandbox, 'fault-config-doctor'),
      clawfix,
    };
    return scenarioResult;
  } finally {
    await exec(
      sandbox,
      'fault-config-restore',
      'cp /tmp/openclaw.json.clawfix-good ~/.openclaw/openclaw.json',
    );
    const restoration = await verifyConfigRestored(sandbox, expectedChecksum);
    if (scenarioResult) scenarioResult.restoration = restoration;
  }
}

async function deadGateway(sandbox) {
  await stopProcess(sandbox, 'openclaw-gateway');
  let scenarioResult;
  try {
    const clawfix = await collectClawFix(sandbox, 'fault-dead-clawfix');
    const verifiedIssueIds = assertScenarioEvidence('dead-gateway', clawfix, {
      expectedIssueIds: ['gateway-not-running'],
      evidence: value => value.diagnostic.nativeStatus?.available === true
        && value.diagnostic.nativeStatus.gateway?.reachable === false,
    });
    scenarioResult = {
      scenario: 'dead-gateway',
      verifiedIssueIds,
      doctor: await collectDoctor(sandbox, 'fault-dead-doctor'),
      clawfix,
    };
    return scenarioResult;
  } finally {
    await startGateway(sandbox);
    const restoration = await verifyGatewayRestored(sandbox);
    if (scenarioResult) scenarioResult.restoration = restoration;
  }
}

async function portConflict(sandbox) {
  await stopProcess(sandbox, 'openclaw-gateway');
  await startDetached(
    sandbox,
    'fault-port-owner',
    'node -e "require(\'node:http\').createServer((q,s)=>s.end(\'occupied\')).listen(18789,\'127.0.0.1\')"',
    [18789],
  );

  let scenarioResult;
  try {
    const startup = await exec(
      sandbox,
      'fault-port-gateway-attempt',
      GATEWAY_COMMAND,
      { timeout: 60, allowedExitCodes: [1] },
    );
    const clawfix = await collectClawFix(sandbox, 'fault-port-clawfix');
    const verifiedIssueIds = assertScenarioEvidence('port-conflict', clawfix, {
      expectedIssueIds: ['runtime/gateway-port-conflict'],
      evidence: value => value.diagnostic.ports?.gateway?.listening === true
        && value.diagnostic.nativeStatus?.gateway?.reachable === false,
    });
    scenarioResult = {
      scenario: 'port-conflict',
      verifiedIssueIds,
      gatewayAttempt: stripAnsi(`${startup.stdout}\n${startup.stderr}`).trim().slice(0, 3000),
      doctor: await collectDoctor(sandbox, 'fault-port-doctor'),
      clawfix,
    };
    return scenarioResult;
  } finally {
    await stopProcess(sandbox, 'fault-port-owner');
    await startGateway(sandbox);
    const restoration = await verifyGatewayRestored(sandbox);
    if (scenarioResult) scenarioResult.restoration = restoration;
  }
}

export async function main() {
  const requested = process.argv[2] || 'all';
  const { SandboxInstance } = await import('@blaxel/core');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Blaxel scenario error: ${error.message}`);
    process.exitCode = 1;
  });
}
