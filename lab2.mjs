import { SandboxInstance } from '@blaxel/core';
const sandbox = await SandboxInstance.createIfNotExists({
  name: 'clawfix-glibc-lab',
  image: process.env.LAB_IMAGE || 'blaxel/prod-base:latest',
  memory: 8192,
  region: process.env.BL_REGION || 'us-pdx-1',
  ports: [{ name: 'clawfix', target: 3001, protocol: 'HTTP' }],
  labels: { project: 'clawfix', purpose: 'glibc-review' },
  ttl: '24h',
});
console.log(JSON.stringify({ name: sandbox.metadata.name, status: sandbox.status, image: sandbox.spec?.runtime?.image }, null, 2));
const r = await sandbox.process.exec({ name: 'probe' + Date.now(), command: 'cat /etc/os-release | head -2; uname -m; node --version 2>/dev/null || echo "no node"; ldd --version 2>&1 | head -1', workingDir: '/', waitForCompletion: true, timeout: 120 });
console.log(`${r.stdout || ''}${r.stderr || ''}`);
