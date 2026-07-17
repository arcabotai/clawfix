import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = new URL('../cli/bin/clawfix.js', import.meta.url);

function run(args) {
  return spawnSync(process.execPath, [cli.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('help documents custom server and protected-server token support', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--server URL/);
  assert.match(result.stdout, /CLAWFIX_API_TOKEN/);
});

test('server option rejects missing and non-HTTP values before scanning', () => {
  const missing = run(['--server']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Missing value for --server/);

  const invalid = run(['--server=file:\/\/\/tmp']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Invalid ClawFix API URL/);
});

test('version remains side-effect free', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^clawfix v\d+\.\d+\.\d+/);
});
