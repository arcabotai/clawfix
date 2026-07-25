#!/usr/bin/env node
/** Provision the review lab: tools, Bun, real OpenClaw, and the local working tree. */
import { readFileSync } from 'node:fs';
import { lab, sh } from './lab.mjs';

const sandbox = await lab();
const TARBALL = process.argv[2];
if (!TARBALL) throw new Error('usage: provision.mjs <tarball>');

console.log('== system tools ==');
console.log((await sh(sandbox, 'tools',
  'apk add --no-cache bash curl jq procps lsof iproute2 coreutils git python3 tar gzip unzip libstdc++ libgcc',
  { workingDir: '/', timeout: 600 })).out.slice(-500));

console.log('== bun ==');
console.log((await sh(sandbox, 'bun',
  'curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.21" && /root/.bun/bin/bun --version',
  { workingDir: '/', timeout: 900, allowFail: true })).out.slice(-800));

console.log('== openclaw ==');
const oc = await sh(sandbox, 'openclaw',
  `npm install --global openclaw@${process.env.OPENCLAW_LAB_VERSION || '2026.6.11'} && openclaw --version`,
  { workingDir: '/', timeout: 1800, allowFail: true });
console.log(`exit=${oc.exitCode}\n${oc.out.slice(-1500)}`);

console.log('== upload working tree ==');
const b64 = readFileSync(TARBALL).toString('base64');
const CHUNK = 700_000;
await sh(sandbox, 'mkdir', 'rm -rf /app/clawfix /app/upload && mkdir -p /app/clawfix /app/upload', { workingDir: '/' });
for (let i = 0, part = 0; i < b64.length; i += CHUNK, part += 1) {
  await sandbox.fs.write(`/app/upload/part-${String(part).padStart(3, '0')}.b64`, b64.slice(i, i + CHUNK));
  process.stdout.write(`  part ${part} (${Math.min(CHUNK, b64.length - i)} chars)\n`);
}
console.log((await sh(sandbox, 'unpack',
  'cat /app/upload/part-*.b64 | tr -d "\\n" | base64 -d > /app/clawfix.tar.gz && tar -xzf /app/clawfix.tar.gz -C /app/clawfix && ls /app/clawfix | head -20',
  { workingDir: '/', timeout: 600 })).out);

console.log('== versions ==');
console.log((await sh(sandbox, 'versions',
  'node --version; npm --version; /root/.bun/bin/bun --version; openclaw --version 2>&1 | head -2; git -C /app/clawfix log --oneline -1 2>/dev/null || echo "(no git)"',
  { allowFail: true })).out);
