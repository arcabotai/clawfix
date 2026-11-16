import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectMemoryReindexLocks } from '../cli/bin/native-diagnostics.js';
import {
  classifyMemorySearchStall,
  retainDiagnosticLogLine,
} from '../cli/bin/security.js';
import { deriveIssues } from '../cli/core/diagnostics.js';
import { repairCatalog } from '../cli/core/repair-catalog.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const LOCK = '/Users/ada/.openclaw/agents/main/agent/openclaw-agent.sqlite.reindex-lock.sqlite';

async function fixture(name) {
  return readFile(new URL(`./fixtures/openclaw-memory-search/${name}`, import.meta.url), 'utf8');
}

function collected(text, extra = {}) {
  return {
    config: { gateway: { mode: 'local' } },
    system: { runtimeCompatible: true, runtimeRequired: null, runtimeCurrent: null },
    gateway: { gatewayStatus: 'running', gatewayPort: 18789, gatewayPid: '9' },
    logs: { errorLogs: text, stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 1, uptimeSeconds: 30, uptimeStr: '30s', nRestarts: 0 },
    workspace: { workspaceDir: '/w', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: true, pid: 9 } },
    nativeDoctor: extra.nativeDoctor || { available: true, findings: [] },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: true } },
    nativeSecurity: { available: true, findings: [] },
    memoryReindexLocks: extra.memoryReindexLocks,
  };
}

function lock(overrides) {
  return {
    path: LOCK,
    bytes: 4096,
    ageMs: 1_000,
    reindexAlive: false,
    ...overrides,
  };
}

test('the 15s memory_search timeout is a stall and a 60s timeout is not', async () => {
  const text = await fixture('timeout.txt');
  assert.equal(retainDiagnosticLogLine('MemorySearch timed out after 15s'), true);
  assert.equal(retainDiagnosticLogLine('memory-lancedb embedding timed out'), true);
  const issue = detectIssues({
    logs: { errors: text },
    openclaw: {},
    config: {},
  }).find(entry => entry.id === 'memory-search-stall');
  assert.ok(issue);
  assert.equal(issue.severity, 'medium');
  assert.match(issue.description, /15s tool deadline/);
  assert.match(issue.description, /--only core\/doctor\/memory-search/);
  assert.match(issue.description, /openclaw memory status --deep/);
  assert.match(issue.description, /153011/);
  assert.match(issue.description, /136405/);
  assert.match(issue.description, /does not delete a lock/);
  assert.equal(issue.fix.includes('rm '), false);
  assert.equal(repairCatalog['memory-search-stall'], undefined);

  assert.equal(detectIssues({
    logs: { errors: await fixture('negatives.txt') },
    openclaw: {},
    config: {},
  }).some(entry => entry.id === 'memory-search-stall'), false);
});

test('a 0-byte or old reindex lock is reported, and a fresh live lock is not', async () => {
  const empty = deriveIssues(collected('', {
    memoryReindexLocks: { reindexAlive: false, locks: [lock({ bytes: 0, ageMs: 2_000 })] },
  })).find(entry => entry.knownIssueId === 'memory-search-stall');
  assert.ok(empty);
  assert.match(empty.description, /~\/\.openclaw\/agents\/main\/agent\/openclaw-agent\.sqlite\.reindex-lock\.sqlite/);
  assert.equal(empty.description.includes('ada'), false);
  assert.match(empty.description, /0-byte/);
  assert.match(empty.description, /age 2s/);
  assert.match(empty.description, /no reindex process is alive/);
  assert.match(empty.description, /rename that lock aside/);
  assert.equal(empty.repairable, false);

  const old = deriveIssues(collected('', {
    memoryReindexLocks: { reindexAlive: false, locks: [lock({ bytes: 8192, ageMs: 120_000 })] },
  })).find(entry => entry.knownIssueId === 'memory-search-stall');
  assert.ok(old);
  assert.match(old.description, /8192 bytes/);
  assert.match(old.description, /age 2m/);

  const unknown = deriveIssues(collected('', {
    memoryReindexLocks: { locks: [lock({ bytes: 0, ageMs: 2_000, reindexAlive: undefined })] },
  })).find(entry => entry.knownIssueId === 'memory-search-stall');
  assert.match(unknown.description, /was not checked/);
  assert.equal(/no reindex process is alive/.test(unknown.description), false);

  for (const live of [
    lock({ bytes: 8192, ageMs: 1_000, reindexAlive: true }),
    lock({ bytes: 0, ageMs: 500, reindexAlive: true }),
    lock({ bytes: 8192, ageMs: 1_000, reindexAlive: false }),
  ]) {
    assert.equal(classifyMemorySearchStall({
      text: await fixture('negatives.txt'),
      locks: [live],
    }), null);
  }
});

test('a doctor line that only repeats the 15s timeout is not listed twice', () => {
  const issues = deriveIssues(collected('MemorySearch timed out after 15s', {
    nativeDoctor: {
      available: true,
      findings: [
        { checkId: 'core/doctor/memory-search', severity: 'warning', message: 'MemorySearch timed out after 15s' },
        { checkId: 'core/doctor/memory-search', severity: 'warning', message: 'Embedding provider is not configured.' },
      ],
    },
  }));
  assert.equal(issues.filter(entry => entry.knownIssueId === 'memory-search-stall').length, 1);
  assert.equal(issues.some(entry => entry.text === 'MemorySearch timed out after 15s'), false);
  assert.equal(issues.some(entry => entry.text === 'Embedding provider is not configured.'), true);
});

test('the state-dir scan reports size and age and ignores a live reindex', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-reindex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'agents', 'main', 'agent');
  await mkdir(dir, { recursive: true });
  const empty = join(dir, 'openclaw-agent.sqlite.reindex-lock.sqlite');
  const fresh = join(dir, 'other.sqlite.reindex-lock.sqlite');
  await writeFile(empty, '');
  await writeFile(fresh, 'sqlite-header');
  const old = new Date(Date.now() - 120_000);
  await utimes(empty, old, old);
  await symlink(fresh, join(dir, 'link.reindex-lock.sqlite'));
  await writeFile(join(dir, 'notes.txt'), 'lock');

  const quiet = () => ({ status: 0, stdout: 'node clawfix\n', stderr: '' });
  const facts = collectMemoryReindexLocks({ stateDir: root, runSync: quiet });
  assert.equal(facts.reindexAlive, false);
  assert.equal(facts.locks.length, 2);
  const emptyLock = facts.locks.find(entry => entry.bytes === 0);
  assert.ok(emptyLock.ageMs >= 60_000);
  assert.match(emptyLock.path, /\.reindex-lock\.sqlite$/);
  assert.equal(facts.locks.some(entry => entry.path.endsWith('notes.txt')), false);
  const stall = classifyMemorySearchStall({ locks: facts.locks });
  assert.equal(stall.locks.length, 1);
  assert.equal(stall.locks[0].bytes, 0);

  const live = collectMemoryReindexLocks({
    stateDir: root,
    runSync: () => ({ status: 0, stdout: 'openclaw memory index --agent main\n', stderr: '' }),
  });
  assert.equal(live.reindexAlive, true);
  const freshLock = live.locks.find(entry => entry.bytes > 0);
  assert.equal(classifyMemorySearchStall({ locks: [freshLock] }), null);
});

test('the hosted script reports the same lock facts and does not delete the file', async (t) => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('MEMORY_REINDEX_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(DIAGNOSTIC_SCRIPT, /"memoryReindexLocks": \$MEMORY_REINDEX_JSON/);
  assert.match(DIAGNOSTIC_SCRIPT, /MemorySearch timed out after 15s/);
  assert.equal(/rm[^\n]*reindex-lock/.test(DIAGNOSTIC_SCRIPT), false);
  assert.equal(snippet.includes('cli/core/'), false);

  const root = await mkdtemp(join(tmpdir(), 'clawfix-hosted-reindex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const state = join(home, '.openclaw', 'agents', 'main', 'agent');
  await mkdir(state, { recursive: true });
  const empty = join(state, 'openclaw-agent.sqlite.reindex-lock.sqlite');
  await writeFile(empty, '');
  await utimes(empty, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  await writeFile(join(state, 'fresh.sqlite.reindex-lock.sqlite'), 'sqlite-header');
  await symlink(empty, join(state, 'link.reindex-lock.sqlite'));

  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$MEMORY_REINDEX_JSON"`], {
    env: { ...process.env, HOME: home, OPENCLAW_DIR: join(home, '.openclaw') },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.includes('home'), false);
  const facts = JSON.parse(printed.stdout);
  assert.equal(facts.reindexAlive, false);
  const emptyLock = facts.locks.find(entry => entry.bytes === 0);
  assert.equal(emptyLock.path, '~/.openclaw/agents/main/agent/openclaw-agent.sqlite.reindex-lock.sqlite');
  assert.ok(emptyLock.ageMs >= 60_000);
  assert.equal(emptyLock.reindexAlive, false);
  assert.equal(facts.locks.length, 2);
  const issue = detectIssues({
    logs: { errors: '' },
    openclaw: { memoryReindexLocks: facts },
    config: {},
  }).find(entry => entry.id === 'memory-search-stall');
  assert.ok(issue);
  assert.match(issue.description, /0-byte/);
  assert.equal(issue.description.includes(home), false);
});
