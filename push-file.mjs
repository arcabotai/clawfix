import { readFileSync } from 'node:fs';
import { lab, sh } from './lab.mjs';
const sandbox = await lab();
const [src, dest] = process.argv.slice(2);
await sandbox.fs.write(dest, readFileSync(src, 'utf8'));
const r = await sh(sandbox, 'verify', `wc -l ${dest}`, { workingDir: '/', allowFail: true });
console.log(r.out.trim());
