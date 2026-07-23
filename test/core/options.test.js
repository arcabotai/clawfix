import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliOptions } from '../../cli/core/options.js';

test('parseCliOptions recognizes aliases and derives local-only one-shot mode', () => {
  const parsed = parseCliOptions(
    ['-n', '--local-only', '-d', '-y', '-h', '-V', '--json'],
    { CLAWFIX_API_TOKEN: 'test-token' },
  );

  assert.deepEqual({
    dryRun: parsed.dryRun,
    noSend: parsed.noSend,
    showData: parsed.showData,
    autoSend: parsed.autoSend,
    showHelp: parsed.showHelp,
    showVersion: parsed.showVersion,
    jsonOnly: parsed.jsonOnly,
    localOnly: parsed.localOnly,
    oneShot: parsed.oneShot,
    apiToken: parsed.apiToken,
  }, {
    dryRun: true,
    noSend: true,
    showData: true,
    autoSend: true,
    showHelp: true,
    showVersion: true,
    jsonOnly: true,
    localOnly: true,
    oneShot: true,
    apiToken: 'test-token',
  });
});

test('parseCliOptions gives the first non-empty inline server precedence and normalizes its URL', () => {
  const parsed = parseCliOptions([
    '--server',
    'https://separate.example/path/',
    '--server=https://first.example/api/',
    '--server=https://second.example/',
  ], {});

  assert.equal(parsed.apiUrl, 'https://first.example/api');
  assert.deepEqual(parsed.validation, { ok: true });
});

test('parseCliOptions preserves empty inline fallback to a separate server value', () => {
  const parsed = parseCliOptions([
    '--server=',
    '--server',
    'http://localhost:3001/',
  ], {});

  assert.equal(parsed.apiUrl, 'http://localhost:3001');
  assert.deepEqual(parsed.validation, { ok: true });
});

test('parseCliOptions uses CLAWFIX_API then the hosted default and snapshots mutable inputs', () => {
  const argv = ['--definitely-unknown'];
  const env = { CLAWFIX_API: 'https://env.example/base/', CLAWFIX_API_TOKEN: 'before' };
  const parsed = parseCliOptions(argv, env);
  argv.push('--json');
  env.CLAWFIX_API = 'https://after.example/';
  env.CLAWFIX_API_TOKEN = 'after';

  assert.equal(parsed.apiUrl, 'https://env.example/base');
  assert.equal(parsed.apiToken, 'before');
  assert.equal(parsed.jsonOnly, false);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.validation), true);
  assert.equal(parseCliOptions([], {}).apiUrl, 'https://clawfix.dev');
});

test('parseCliOptions reports a missing server value structurally before URL validation', () => {
  const parsed = parseCliOptions(['--server'], { CLAWFIX_API: 'file:///tmp' });

  assert.deepEqual(parsed.validation, {
    ok: false,
    type: 'missing-server',
    message: 'Missing value for --server',
    exitCode: 2,
  });
});

test('parseCliOptions reports invalid server protocols with the current exact error text', () => {
  const parsed = parseCliOptions(['--server=file:///tmp'], {});

  assert.deepEqual(parsed.validation, {
    ok: false,
    type: 'invalid-server',
    message: 'Invalid ClawFix API URL: must use http or https',
    exitCode: 2,
  });
});
