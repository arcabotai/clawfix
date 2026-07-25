import { readFileSync } from 'node:fs';
import { lab, sh } from './lab.mjs';
const sandbox = await lab();
const b64 = readFileSync(process.argv[2]).toString('base64');
await sh(sandbox, 'clean', 'rm -rf /app/clawfix /app/upload && mkdir -p /app/clawfix /app/upload', { workingDir: '/' });
const CHUNK = 700_000;
for (let i = 0, p = 0; i < b64.length; i += CHUNK, p += 1) {
  await sandbox.fs.write(`/app/upload/part-${String(p).padStart(3,'0')}.b64`, b64.slice(i, i + CHUNK));
}
const r = await sh(sandbox, 'unpack', 'cat /app/upload/part-*.b64 | tr -d "\\n" | base64 -d > /app/c.tgz && tar -xzf /app/c.tgz -C /app/clawfix && find /app/clawfix -name "._*" | wc -l && npm install --no-audit --no-fund 2>&1 | tail -2', { workingDir: '/app/clawfix', timeout: 900 });
console.log(r.out);
