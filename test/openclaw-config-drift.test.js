import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import {
  applySessionTranscriptIndexing,
  detectIssues,
  hasLegacyHeartbeatConfig,
  KNOWN_ISSUES,
  sessionTranscriptsIndexed,
} from '../src/known-issues.js';

function issueById(id) {
  return KNOWN_ISSUES.find(issue => issue.id === id);
}

function detectedIds(config) {
  return detectIssues({ config }).map(issue => issue.id);
}

function collected(config, overrides = {}) {
  return {
    config,
    system: { runtimeCompatible: true, nodeVersion: 'v22.0.0', ...overrides.system },
    gateway: {
      gatewayStatus: 'runtime: ok\nrunning, pid 4242',
      gatewayPort: 18789,
      gatewayPid: '4242',
      ...overrides.gateway,
    },
    logs: {
      errorLogs: '',
      stderrLogs: '',
      gatewayLogTail: '',
      errLogSizeMB: 0,
      ...overrides.logs,
    },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: {
      workspaceDir: '',
      hasSoul: true,
      memoryFiles: 1,
      codexHome: { matchesExpected: true },
      ...overrides.workspace,
    },
    ports: {
      gateway: {
        valid: true,
        available: true,
        listening: false,
        process: null,
        pid: null,
        collector: 'ss',
      },
    },
    nativeDoctor: { available: false, findings: [] },
    nativeConfig: { available: false, valid: null, warnings: [], errors: [] },
    nativeStatus: { available: false },
    nativeSecurity: { available: false, findings: [] },
  };
}

const healthyModern = {
  agents: {
    defaults: {
      model: 'openai/gpt-5',
      contextPruning: { mode: 'cache-ttl', ttl: '6h' },
      compaction: { memoryFlush: { enabled: true } },
    },
  },
  memory: {
    search: {
      query: { maxResults: 6, minScore: 0.35 },
    },
  },
};

const hybridOldKey = {
  agents: {
    defaults: {
      contextPruning: { mode: 'cache-ttl' },
      compaction: { memoryFlush: { enabled: true } },
      memorySearch: { query: { hybrid: { enabled: false } } },
    },
  },
};

const hybridCurrentKey = {
  memory: {
    search: {
      enabled: true,
      query: { maxResults: 6, minScore: 0.35 },
    },
  },
};

const sessionOldKey = {
  agents: {
    defaults: {
      contextPruning: { mode: 'cache-ttl' },
      compaction: { memoryFlush: { enabled: true } },
      memorySearch: { sessionTranscripts: { enabled: true } },
    },
  },
  memory: {
    search: { rememberAcrossConversations: false },
  },
};

const sessionCurrentKey = {
  agents: {
    defaults: {
      contextPruning: { mode: 'cache-ttl' },
      compaction: { memoryFlush: { enabled: true } },
    },
  },
  memory: {
    search: {
      rememberAcrossConversations: false,
      experimental: { sessionMemory: true },
      sources: ['memory', 'sessions'],
    },
  },
};

const heartbeatOldKey = {
  agents: {
    defaults: {
      compaction: { memoryFlush: { enabled: true } },
      heartbeat: { every: '15m' },
    },
  },
  memory: { search: { query: { maxResults: 6 } } },
};

const heartbeatCurrentKey = {
  agents: {
    defaults: {
      model: 'openai/gpt-5',
      contextPruning: { mode: 'cache-ttl' },
      compaction: { memoryFlush: { enabled: true } },
    },
  },
  memory: { search: { query: { maxResults: 6, minScore: 0.35 } } },
};

test('retired hybrid search does not fire on old, current, or healthy configs', () => {
  assert.equal(issueById('no-hybrid-search'), undefined);
  for (const config of [hybridOldKey, hybridCurrentKey, healthyModern]) {
    assert.equal(detectedIds(config).includes('no-hybrid-search'), false);
    const texts = deriveIssues(collected(config)).map(issue => issue.text);
    assert.equal(texts.includes('Hybrid search not enabled (recommended)'), false);
  }
});

test('session transcript indexing follows the current memory.search gate', () => {
  assert.equal(sessionTranscriptsIndexed(sessionOldKey), false);
  assert.equal(detectedIds(sessionOldKey).includes('session-transcript-not-indexed'), true);

  assert.equal(sessionTranscriptsIndexed(sessionCurrentKey), true);
  assert.equal(detectedIds(sessionCurrentKey).includes('session-transcript-not-indexed'), false);

  assert.equal(sessionTranscriptsIndexed(healthyModern), true);
  assert.equal(detectedIds(healthyModern).includes('session-transcript-not-indexed'), false);

  const rememberAcross = {
    memory: { search: { rememberAcrossConversations: true } },
  };
  assert.equal(sessionTranscriptsIndexed(rememberAcross), true);
  assert.equal(detectedIds(rememberAcross).includes('session-transcript-not-indexed'), false);

  const sessionMemoryWithoutSources = {
    memory: {
      search: {
        rememberAcrossConversations: false,
        experimental: { sessionMemory: true },
      },
    },
  };
  assert.equal(sessionTranscriptsIndexed(sessionMemoryWithoutSources), false);
  assert.equal(detectedIds(sessionMemoryWithoutSources).includes('session-transcript-not-indexed'), true);
});

test('session transcript repair writes the current keys and drops the rejected legacy key', () => {
  const issue = issueById('session-transcript-not-indexed');
  assert.doesNotMatch(issue.fix, /sessionTranscripts\.enabled\s*=/);
  assert.doesNotMatch(issue.fix, /agents\.defaults\.memorySearch[^\)]/);
  assert.match(issue.fix, /del\(\.memory\.search\.sessionTranscripts\)/);
  assert.match(issue.fix, /memory\.search\.experimental\.sessionMemory = true/);
  assert.match(issue.fix, /"sessions"/);
  assert.match(issue.fix, /del\(\.agents\.defaults\.memorySearch\)/);
  assert.doesNotMatch(issue.fix, /rememberAcrossConversations = true/);

  const repaired = applySessionTranscriptIndexing(sessionOldKey);
  assert.equal(repaired.memory.search.experimental.sessionMemory, true);
  assert.deepEqual(repaired.memory.search.sources, ['memory', 'sessions']);
  assert.equal(repaired.memory.search.rememberAcrossConversations, false);
  assert.equal(repaired.agents.defaults.memorySearch, undefined);
  assert.equal(sessionTranscriptsIndexed(repaired), true);
  assert.equal(detectedIds(repaired).includes('session-transcript-not-indexed'), false);
});

test('legacy heartbeat is advisory and does not write heartbeat keys', () => {
  assert.equal(hasLegacyHeartbeatConfig(heartbeatOldKey), true);
  assert.equal(detectedIds(heartbeatOldKey).includes('heartbeat-no-model-override'), true);
  assert.equal(detectedIds(heartbeatOldKey).includes('high-token-usage'), true);

  assert.equal(hasLegacyHeartbeatConfig(heartbeatCurrentKey), false);
  assert.equal(detectedIds(heartbeatCurrentKey).includes('heartbeat-no-model-override'), false);
  assert.equal(detectedIds(heartbeatCurrentKey).includes('high-token-usage'), false);

  assert.equal(hasLegacyHeartbeatConfig(healthyModern), false);
  assert.equal(detectedIds(healthyModern).includes('heartbeat-no-model-override'), false);
  assert.equal(detectedIds(healthyModern).includes('high-token-usage'), false);

  const withModel = {
    agents: { defaults: { heartbeat: { every: '30m', model: 'anthropic/claude-sonnet-4-6' } } },
  };
  assert.equal(detectedIds(withModel).includes('heartbeat-no-model-override'), true);
  assert.equal(detectedIds(withModel).includes('high-token-usage'), false);

  const perAgent = {
    agents: { entries: { main: { heartbeat: { every: '10m' } } } },
  };
  assert.equal(detectedIds(perAgent).includes('heartbeat-no-model-override'), true);

  for (const id of ['heartbeat-no-model-override', 'high-token-usage']) {
    const fix = issueById(id).fix;
    assert.doesNotMatch(fix, /\bjq\b/);
    assert.doesNotMatch(fix, /config set/);
    assert.match(fix, /openclaw doctor --fix/);
    assert.match(fix, /automations/);
  }
});

test('a retired heartbeat model is not treated as an active model route', () => {
  const config = {
    plugins: {
      entries: {
        codex: { enabled: true, config: { appServer: { serviceTier: 'fast', requestTimeoutMs: 120000 } } },
      },
    },
    agents: {
      defaults: {
        agentRuntime: 'codex',
        heartbeat: { model: 'openai-codex/gpt-5' },
        contextPruning: { mode: 'cache-ttl' },
        compaction: { memoryFlush: { enabled: true } },
      },
    },
  };
  const texts = deriveIssues(collected(config)).map(issue => issue.text);
  assert.equal(texts.includes('PI-backed openai-codex route active instead of native Codex harness'), false);
  assert.equal(detectedIds(config).includes('pi-backed-openai-codex-route'), false);
});

test('hosted and legacy repair surfaces do not assign the retired keys', async () => {
  const [plain, script] = await Promise.all([
    readFile(new URL('../cli/interfaces/plain.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/script.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(plain, /memorySearch/);
  assert.doesNotMatch(plain, /heartbeat\.model\s*=/);
  assert.match(plain, /heartbeat-no-model-override/);
  assert.match(plain, /informational: true/);
  assert.doesNotMatch(script, /memorySearch/);

  assert.equal(repairCatalog['no-hybrid-search'], undefined);
  for (const entry of Object.values(repairCatalog)) {
    const key = typeof entry.key === 'string' ? entry.key : '';
    assert.equal(key.includes('memorySearch'), false, entry.id);
    assert.equal(key.includes('heartbeat'), false, entry.id);
  }
});
