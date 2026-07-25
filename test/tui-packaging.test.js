import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function runCli(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cwd, 'bin/clawfix.js'), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Reproduce the published package layout: cli/package.json `files` ships bin/, adapters/,
 * core/ and interfaces/ — never tui/.
 */
async function stagePublishedLayout() {
  const dir = await mkdtemp(join(tmpdir(), 'clawfix-pkg-'));
  for (const entry of ['bin', 'adapters', 'core', 'interfaces']) {
    await cp(new URL(`cli/${entry}`, root), join(dir, entry), { recursive: true });
  }
  await cp(new URL('cli/package.json', root), join(dir, 'package.json'));
  return dir;
}

test('the published package allowlist does not ship the OpenTUI session', async () => {
  const manifest = JSON.parse(await readFile(new URL('cli/package.json', root), 'utf8'));
  assert.ok(Array.isArray(manifest.files));
  assert.ok(
    !manifest.files.some((entry) => String(entry).includes('tui')),
    'the OpenTUI session is distributed as a standalone binary, not inside the npm package',
  );
});

test('--tui on the published layout explains the standalone binary instead of blaming Bun', async () => {
  const dir = await stagePublishedLayout();
  try {
    const result = await runCli(dir, ['--tui']);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.code, 2);
    assert.match(output, /not bundled in the clawfix npm package/i);
    assert.match(output, /releases\/latest/);
    assert.match(output, /npx clawfix --plain/);

    // The old failure mode surfaced a spawn error naming the Bun binary, which sent users to
    // reinstall a Bun that was already present.
    assert.doesNotMatch(output, /spawn .*bun.* ENOENT/i);
    assert.doesNotMatch(output, /requires Bun/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('help text points at the standalone binary and never promises a TUI from npm', async () => {
  const dir = await stagePublishedLayout();
  try {
    const { stdout } = await runCli(dir, ['--help']);
    assert.match(stdout, /Not bundled in this npm package/);
    assert.match(stdout, /releases\/latest/);
    assert.doesNotMatch(stdout, /OpenTUI session \(default/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a source checkout still resolves the OpenTUI entry', async () => {
  // Guards against the existence check being satisfied only by the published layout.
  const { access } = await import('node:fs/promises');
  await access(new URL('cli/tui/src/main.tsx', root));
});
