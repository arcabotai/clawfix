import { lab, sh } from './lab.mjs';
const sandbox = await lab();
const cmd = process.argv[2];
const wd = process.argv[3] || '/app/clawfix';
const r = await sh(sandbox, 'run', cmd, { workingDir: wd, timeout: Number(process.env.LAB_TIMEOUT || 1800), allowFail: true });
console.log(`exit=${r.exitCode}`);
console.log(r.out);
