import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliOptions } from '../../cli/core/options.js';
import { resolveCliMode } from '../../cli/core/modes.js';

test('resolveCliMode prioritizes version before help and validation', () => {
  const parsed = parseCliOptions(
    ['--help', '--version', '--server=file:///tmp'],
    {},
  );

  assert.deepEqual(resolveCliMode(parsed), { kind: 'version' });
});

test('resolveCliMode prioritizes help before server validation', () => {
  const parsed = parseCliOptions(['--help', '--server'], {});

  assert.deepEqual(resolveCliMode(parsed), { kind: 'help' });
});

test('resolveCliMode returns structured missing-server validation before dispatch', () => {
  const parsed = parseCliOptions(['--server', '--scan'], { CLAWFIX_API: 'file:///tmp' });

  assert.deepEqual(resolveCliMode(parsed), {
    kind: 'error',
    error: {
      ok: false,
      type: 'missing-server',
      message: 'Missing value for --server',
      exitCode: 2,
    },
  });
});

test('resolveCliMode returns structured invalid-URL validation before dispatch', () => {
  const parsed = parseCliOptions(['--server=file:///tmp', '--scan'], {});

  assert.deepEqual(resolveCliMode(parsed), {
    kind: 'error',
    error: {
      ok: false,
      type: 'invalid-server',
      message: 'Invalid ClawFix API URL: must use http or https',
      exitCode: 2,
    },
  });
});

test('resolveCliMode selects one-shot then interactive as final dispatch choices', () => {
  assert.deepEqual(resolveCliMode(parseCliOptions(['--scan'], {})), { kind: 'one-shot' });
  assert.deepEqual(resolveCliMode(parseCliOptions([], {})), { kind: 'interactive' });
});

test('resolveCliMode selects experimental OpenTUI before interactive defaults', () => {
  assert.deepEqual(resolveCliMode(parseCliOptions(['--tui'], {})), { kind: 'tui' });
  assert.equal(parseCliOptions(['--tui'], {}).tui, true);
});
