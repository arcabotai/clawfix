import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { deriveIssues } from '../cli/core/diagnostics.js';
import {
  collectStuckSessionWindows,
  stuckSessionWindowCount,
} from '../cli/bin/security.js';
import { detectIssues } from '../src/known-issues.js';
import { DIAGNOSTIC_SCRIPT } from '../src/routes/script.js';

const STUCK_KEY = 'agent:main:cron:job-1:run:run-1';

function createStore(file, { stuck = false } = {}) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE session_nodes (
      session_key TEXT PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      entry_valid INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      status TEXT,
      ended_at INTEGER,
      started_at INTEGER
    );
  `);
  if (stuck) {
    database.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, entry_valid, updated_at)
      VALUES (?, 'run-1', '{}', -1, 1)`).run(STUCK_KEY);
    database.prepare(`INSERT INTO session_windows
      (session_id, session_key, status, ended_at, started_at)
      VALUES ('run-1', ?, 'running', NULL, 1)`).run(STUCK_KEY);
  } else {
    database.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, entry_valid, updated_at)
      VALUES ('agent:main:main', 'live', '{"ok":true}', 1, 1)`).run();
    database.prepare(`INSERT INTO session_windows
      (session_id, session_key, status, ended_at, started_at)
      VALUES ('live', 'agent:main:main', 'running', NULL, 1)`).run();
  }
  database.close();
}

test('captured OpenClaw commands miss a running invalid session window', async () => {
  const listed = JSON.parse(await readFile(new URL(
    './fixtures/openclaw-session-windows/sessions-list.json',
    import.meta.url,
  ), 'utf8'));
  const inspected = JSON.parse(await readFile(new URL(
    './fixtures/openclaw-session-windows/doctor-inspect.json',
    import.meta.url,
  ), 'utf8'));
  assert.equal(listed.count, 0);
  assert.deepEqual(listed.sessions, []);
  assert.equal(inspected.totals.issues, 0);
  assert.equal(inspected.targets[0].issues.length, 0);
  assert.equal(JSON.stringify(listed).includes('/tmp/'), false);
  assert.equal(JSON.stringify(inspected).includes('/tmp/'), false);
});

test('the read-only scan counts only an empty invalid running window', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stuckDir = join(root, 'agents', 'main', 'agent');
  const liveDir = join(root, 'agents', 'other', 'agent');
  await mkdir(stuckDir, { recursive: true });
  await mkdir(liveDir, { recursive: true });
  createStore(join(stuckDir, 'openclaw-agent.sqlite'), { stuck: true });
  createStore(join(liveDir, 'openclaw-agent.sqlite'), { stuck: false });
  const found = await collectStuckSessionWindows(root);
  assert.deepEqual(found, { count: 1, agents: ['main'] });
  assert.equal(stuckSessionWindowCount(found), 1);
  assert.equal(stuckSessionWindowCount({ count: 0, agents: [] }), 0);
});

test('deriveIssues and the server stay advisory for a stuck window', () => {
  const issues = deriveIssues({
    config: { agents: { defaults: { contextPruning: { mode: 'cache-ttl' }, compaction: { memoryFlush: { enabled: true } } } } },
    system: { runtimeCompatible: true },
    gateway: { gatewayStatus: 'running, pid 1', gatewayPort: 18789, gatewayPid: '1' },
    logs: { errorLogs: '', stderrLogs: '', gatewayLogTail: '', errLogSizeMB: 0 },
    serviceHealth: { runs: 0, uptimeSeconds: 0, uptimeStr: '', nRestarts: 0 },
    workspace: { workspaceDir: '/w', hasSoul: true, memoryFiles: 1 },
    ports: { gateway: { listening: false, pid: null } },
    nativeDoctor: { available: true, findings: [] },
    nativeConfig: { available: true, valid: true, errors: [] },
    nativeStatus: { available: true, gateway: { reachable: true } },
    nativeSecurity: { available: true, findings: [] },
    stuckSessionWindows: { count: 2, agents: ['main'] },
  });
  const issue = issues.find(entry => entry.knownIssueId === 'stuck-invalid-session-window');
  assert.ok(issue);
  assert.match(issue.description, /2 session window/);
  assert.equal(issue.description.includes(STUCK_KEY), false);
  const server = detectIssues({
    openclaw: { stuckSessionWindows: { count: 2, agents: ['main'] } },
    config: {},
  }).find(entry => entry.id === 'stuck-invalid-session-window');
  assert.ok(server);
  assert.match(server.fix, /Do not delete the row/);
  assert.equal(detectIssues({
    openclaw: { stuckSessionWindows: { count: 0, agents: [] } },
    config: {},
  }).some(entry => entry.id === 'stuck-invalid-session-window'), false);
});

test('the hosted script uses the same stuck-window query', async (t) => {
  const start = DIAGNOSTIC_SCRIPT.indexOf('STUCK_SESSION_WINDOWS_JSON=null');
  const end = DIAGNOSTIC_SCRIPT.indexOf('# --- Build Diagnostic Payload ---');
  assert.ok(start > 0 && end > start);
  const snippet = DIAGNOSTIC_SCRIPT.slice(start, end);
  assert.match(snippet, /entry_valid = -1/);
  assert.match(snippet, /entry_json = '\{\}'/);
  assert.match(snippet, /status = 'running'/);
  assert.equal(snippet.includes('cli/core/'), false);

  const root = await mkdtemp(join(tmpdir(), 'clawfix-hosted-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agents', 'main', 'agent');
  await mkdir(agentDir, { recursive: true });
  createStore(join(agentDir, 'openclaw-agent.sqlite'), { stuck: true });
  const printed = spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$STUCK_SESSION_WINDOWS_JSON"`], {
    env: { ...process.env, OPENCLAW_DIR: root },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.doesNotMatch(printed.stderr, /ExperimentalWarning/);
  assert.deepEqual(JSON.parse(printed.stdout), { count: 1, agents: ['main'] });
  assert.equal(printed.stdout.includes(STUCK_KEY), false);
});

test('CLI JSON mode stays quiet when Node 22 loads sqlite for an agent database', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clawfix-cli-sqlite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const workspace = join(home, 'workspace');
  const agentDir = join(home, '.openclaw', 'agents', 'main', 'agent');
  await mkdir(agentDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(workspace, { recursive: true });
  createStore(join(agentDir, 'openclaw-agent.sqlite'), { stuck: true });
  await writeFile(join(home, '.openclaw', 'openclaw.json'), `${JSON.stringify({
    gateway: { port: 65431 },
    agents: { defaults: { workspace } },
  })}\n`);
  await writeFile(join(workspace, 'SOUL.md'), '# Test soul\n');
  const openclaw = join(bin, 'openclaw');
  await writeFile(openclaw, `#!/bin/sh
case "$*" in
  "--version") echo '2026.7.1' ;;
  "gateway status"*) echo 'Runtime: running (pid 4242)' ;;
  "doctor "*) echo '{"ok":true,"checksRun":1,"checksSkipped":0,"findings":[]}' ;;
  "config validate --json") echo '{"valid":true,"issues":[],"warnings":[]}' ;;
  "status --json") echo '{"runtimeVersion":"2026.7.1","gateway":{"reachable":true}}' ;;
  "security audit --json") echo '{"summary":{"critical":0,"warn":0,"info":0},"findings":[]}' ;;
  *) exit 0 ;;
esac
`);
  await chmod(openclaw, 0o755);
  await writeFile(join(bin, 'which'), `#!/bin/sh
if [ "$1" = "openclaw" ] && [ -n "$CLAWFIX_TEST_OPENCLAW" ] && [ -x "$CLAWFIX_TEST_OPENCLAW" ]; then
  printf '%s\\n' "$CLAWFIX_TEST_OPENCLAW"
  exit 0
fi
exit 1
`);
  await chmod(join(bin, 'which'), 0o755);
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' \'10.0.0\'\n');
  await chmod(join(bin, 'npm'), 0o755);
  for (const command of ['id', 'launchctl', 'lsof', 'pgrep', 'ps', 'ss', 'systemctl', 'tail']) {
    await writeFile(join(bin, command), '#!/bin/sh\nexit 1\n');
    await chmod(join(bin, command), 0o755);
  }

  const child = spawnSync(process.execPath, [
    new URL('../cli/bin/clawfix.js', import.meta.url).pathname,
    '--json',
  ], {
    env: {
      HOME: home,
      PATH: bin,
      CLAWFIX_TEST_OPENCLAW: openclaw,
      CLAWFIX_API: 'http://127.0.0.1:9',
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr.includes('ExperimentalWarning'), false);
  const output = JSON.parse(child.stdout);
  assert.equal(output.ok, true);
  assert.equal(
    output.issues.some(issue => issue.knownIssueId === 'stuck-invalid-session-window'),
    true,
  );
});
