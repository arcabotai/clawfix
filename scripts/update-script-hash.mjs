#!/usr/bin/env node
/**
 * Regenerate the repo's SCRIPT_HASH file from the diagnostic script actually served by
 * GET /fix.
 *
 * /fix/sha256 tells users to compare the served hash against
 * https://github.com/arcabotai/clawfix/blob/main/SCRIPT_HASH, so a stale file breaks the
 * documented verification ritual — the honest user sees a mismatch and the only available
 * lesson is "ignore the mismatch".
 *
 * Run after any edit to src/routes/script.js. `npm test` fails if it was not run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCRIPT_HASH } from '../src/routes/script.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASH_FILE = join(ROOT, 'SCRIPT_HASH');

const current = (() => {
  try {
    return readFileSync(HASH_FILE, 'utf8').trim();
  } catch {
    return '';
  }
})();

if (current === SCRIPT_HASH) {
  console.log(`SCRIPT_HASH already current: ${SCRIPT_HASH}`);
  process.exit(0);
}

writeFileSync(HASH_FILE, `${SCRIPT_HASH}\n`);
console.log(`SCRIPT_HASH updated`);
console.log(`  was: ${current || '(missing)'}`);
console.log(`  now: ${SCRIPT_HASH}`);
