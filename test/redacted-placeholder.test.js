import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { redactOutbound } from '../cli/bin/security.js';
import {
  deriveIssues,
  OPENCLAW_REDACTED_PLACEHOLDER,
} from '../cli/core/diagnostics.js';
import { normalizeFindings } from '../cli/core/findings.js';
import { detectIssues, KNOWN_ISSUES } from '../src/known-issues.js';
import { validateRepairScript } from '../src/repair-validator.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const PLACEHOLDER = OPENCLAW_REDACTED_PLACEHOLDER;
const PROVIDER_SECRET = 'sk-test-provider-secret-value';
const CHANNEL_SECRET = 'discord-bot-token-value';
const GATEWAY_SECRET = 'gateway-secret-value-should-not-leak';

function finding(diagnostic) {
  return detectIssues(diagnostic).find(issue => issue.id === 'redacted-placeholder-corruption');
}

function collected(config) {
  return {
    config,
    system: { runtimeCompatible: true, nodeVersion: 'v22.0.0' },
    gateway: {
      gatewayStatus: 'runtime: ok\nrunning, pid 4242',
      gatewayPort: 18789,
      gatewayPid: '4242',
    },
    logs: { errorLogs: '', stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '', hasSoul: true, memoryFiles: 1, codexHome: { matchesExpected: true } },
    ports: {
      gateway: {
        valid: true, available: true, listening: false, process: null, pid: null, collector: 'ss',
      },
    },
    nativeDoctor: { available: false, findings: [] },
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
  };
}

test('a persisted placeholder in a provider key is advisory and names only that path', () => {
  const config = {
    models: {
      providers: {
        openai: { apiKey: PLACEHOLDER, baseUrl: 'https://example.test' },
      },
    },
    gateway: { auth: { token: GATEWAY_SECRET } },
  };
  const issue = finding({ config });
  assert.ok(issue);
  assert.equal(issue.severity, 'high');
  assert.match(issue.description, /models\.providers\.openai\.apiKey/);
  assert.equal(issue.description.includes(GATEWAY_SECRET), false);
  assert.equal(issue.description.includes(PLACEHOLDER) , true);
  assert.equal(issue.fix.includes(GATEWAY_SECRET), false);
  assert.match(issue.fix, /openclaw secrets/);
  assert.match(issue.fix, /openclaw config set <dot\.path>/);
  assert.equal(issue.fix.includes('openclaw.json'), false);

  const local = deriveIssues(collected(config))
    .find(item => item.knownIssueId === 'redacted-placeholder-corruption');
  assert.ok(local);
  assert.match(local.description, /models\.providers\.openai\.apiKey/);
  assert.equal(local.description.includes(GATEWAY_SECRET), false);
  const normalized = normalizeFindings({ localIssues: [local], knownRepairIds: ['gateway-not-running'] });
  assert.equal(normalized[0].repairable, false);
  assert.equal(normalized[0].repairId, undefined);
});

test('a persisted placeholder in a channel token names that path and does not write the token', () => {
  const config = {
    channels: {
      discord: { token: PLACEHOLDER, enabled: true },
    },
  };
  const issue = finding({ config });
  assert.ok(issue);
  assert.match(issue.description, /channels\.discord\.token/);
  assert.equal(issue.description.includes(CHANNEL_SECRET), false);
  const validation = validateRepairScript(issue.fix);
  assert.equal(validation.ok, true, JSON.stringify(validation.blockers));
});

test('a clean config and ClawFix collector redaction do not fire the placeholder detector', () => {
  const clean = {
    gateway: { port: 18789, auth: { mode: 'token' } },
    models: {
      providers: {
        openai: { apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' } },
      },
    },
    channels: { discord: { enabled: true } },
    agents: {
      defaults: {
        contextPruning: { mode: 'cache-ttl' },
        compaction: { memoryFlush: { enabled: true } },
      },
    },
  };
  assert.equal(finding({ config: clean }), undefined);
  assert.equal(
    deriveIssues(collected(clean)).some(item => item.knownIssueId === 'redacted-placeholder-corruption'),
    false,
  );

  const collectedSecrets = {
    models: { providers: { openai: { apiKey: PROVIDER_SECRET } } },
    channels: { discord: { token: CHANNEL_SECRET } },
    gateway: { auth: { token: GATEWAY_SECRET } },
    notes: `see ${PLACEHOLDER} in the docs`,
  };
  const redacted = redactOutbound({ config: collectedSecrets });
  assert.equal(redacted.config.models.providers.openai.apiKey, '***REDACTED***');
  assert.equal(redacted.config.channels.discord.token, '***REDACTED***');
  assert.equal(redacted.config.gateway.auth, '***REDACTED***');
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(PROVIDER_SECRET), false);
  assert.equal(serialized.includes(CHANNEL_SECRET), false);
  assert.equal(serialized.includes(GATEWAY_SECRET), false);
  assert.equal(finding(redacted), undefined);

  const alreadyMarked = {
    config: {
      models: { providers: { openai: { apiKey: '***REDACTED***' } } },
      channels: { discord: { token: '***REDACTED***' } },
    },
  };
  assert.equal(finding(alreadyMarked), undefined);
});

test('only a whole-value OpenClaw placeholder survives redaction and is reported by path', () => {
  const config = {
    models: { providers: { openai: { apiKey: `  ${PLACEHOLDER}  ` } } },
    channels: {
      discord: { token: `${PLACEHOLDER}-not-a-whole-value` },
      slack: { accounts: [{ botToken: PLACEHOLDER }] },
    },
    gateway: { auth: { token: GATEWAY_SECRET } },
    label: `__openclaw_redacted__`,
  };
  const redacted = redactOutbound({ config });
  assert.equal(redacted.config.models.providers.openai.apiKey, PLACEHOLDER);
  assert.equal(redacted.config.channels.discord.token, '***REDACTED***');
  assert.equal(redacted.config.channels.slack.accounts[0].botToken, PLACEHOLDER);
  assert.equal(redacted.config.gateway.auth, '***REDACTED***');
  assert.equal(JSON.stringify(redacted).includes(GATEWAY_SECRET), false);

  const issue = finding(redacted);
  assert.ok(issue);
  assert.match(issue.description, /models\.providers\.openai\.apiKey/);
  assert.match(issue.description, /channels\.slack\.accounts\.0\.botToken/);
  assert.equal(issue.description.includes('channels.discord.token'), false);
  assert.equal(issue.description.includes('gateway.auth.token'), false);
  assert.equal(finding({ config: { label: 'prefix __OPENCLAW_REDACTED__ suffix' } }), undefined);

  const onlyPlaceholders = redactOutbound({
    config: {
      models: { providers: { openai: { apiKey: PLACEHOLDER } } },
      channels: { discord: { token: PLACEHOLDER } },
    },
  });
  assert.ok(finding(onlyPlaceholders));
  assert.equal(
    detectIssues(onlyPlaceholders).some(item => item.id === 'plaintext-secrets-in-config'),
    false,
  );
});

test('env placeholders are reported from paths captured before the env block is removed', () => {
  const envSecret = 'env-secret-must-not-leak';
  const raw = {
    env: { OPENAI_API_KEY: PLACEHOLDER, UNRELATED: envSecret },
    models: { providers: { openai: { apiKey: PLACEHOLDER } } },
  };
  const local = deriveIssues(collected(raw))
    .find(item => item.knownIssueId === 'redacted-placeholder-corruption');
  assert.match(local.description, /env\.OPENAI_API_KEY/);
  assert.match(local.description, /models\.providers\.openai\.apiKey/);
  assert.equal(local.description.includes(envSecret), false);

  const config = { models: raw.models };
  const uploaded = redactOutbound({
    config,
    openclaw: { redactedPlaceholderPaths: ['env.OPENAI_API_KEY', 'models.providers.openai.apiKey', '$(rm)', 'gateway.auth.token=secret'] },
  });
  assert.equal('env' in uploaded.config, false);
  const issue = finding(uploaded);
  assert.match(issue.description, /env\.OPENAI_API_KEY/);
  assert.match(issue.description, /models\.providers\.openai\.apiKey/);
  assert.equal(issue.description.includes('$(rm)'), false);
  assert.equal(issue.description.includes(envSecret), false);
  assert.equal(JSON.stringify(uploaded).includes(envSecret), false);
});

test('the hosted curl collector keeps the OpenClaw placeholder and still redacts real secrets', () => {
  const match = DIAGNOSTIC_SCRIPT.match(/SANITIZED_CONFIG=\$\(jq '([\s\S]*?)' "\$OPENCLAW_CONFIG"/);
  assert.ok(match, 'jq sanitizer is present');
  const input = {
    env: { OPENAI_API_KEY: PROVIDER_SECRET },
    gateway: { auth: { token: PLACEHOLDER } },
    channels: {
      discord: { token: PLACEHOLDER, accessToken: CHANNEL_SECRET },
      slack: { apiKey: PLACEHOLDER },
    },
    models: { providers: { openai: { apiKey: PLACEHOLDER } } },
  };
  const result = spawnSync('jq', [match[1]], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const sanitized = JSON.parse(result.stdout);
  assert.equal('env' in sanitized, false);
  assert.equal(sanitized.gateway.auth.token, PLACEHOLDER);
  assert.equal(sanitized.channels.discord.token, PLACEHOLDER);
  assert.equal(sanitized.channels.discord.accessToken, '***REDACTED***');
  assert.equal(sanitized.channels.slack.apiKey, PLACEHOLDER);
  assert.equal(sanitized.models.providers.openai.apiKey, PLACEHOLDER);
  assert.equal(result.stdout.includes(PROVIDER_SECRET), false);
  assert.equal(result.stdout.includes(CHANNEL_SECRET), false);

  const beforeServiceRedaction = finding({ config: sanitized });
  assert.match(beforeServiceRedaction.description, /gateway\.auth\.token/);
  assert.match(beforeServiceRedaction.description, /channels\.discord\.token/);

  const afterServiceRedaction = finding(redactOutbound({ config: sanitized }));
  assert.match(afterServiceRedaction.description, /channels\.discord\.token/);
  assert.match(afterServiceRedaction.description, /channels\.slack\.apiKey/);
  assert.match(afterServiceRedaction.description, /models\.providers\.openai\.apiKey/);
  assert.equal(afterServiceRedaction.description.includes('channels.discord.accessToken'), false);
  assert.equal(afterServiceRedaction.description.includes(CHANNEL_SECRET), false);
});

test('the placeholder repair stays out of the executable catalog', () => {
  const issue = KNOWN_ISSUES.find(item => item.id === 'redacted-placeholder-corruption');
  assert.ok(issue);
  assert.equal(issue.fix.includes('openclaw.json'), false);
  assert.match(issue.fix, /No config changes were made/);
});
