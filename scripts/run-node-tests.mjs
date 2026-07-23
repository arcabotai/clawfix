#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

const files = (await collect('test')).sort();
if (files.length === 0) {
  console.error('No test files found under test/');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
child.on('error', error => {
  console.error(error);
  process.exit(1);
});
