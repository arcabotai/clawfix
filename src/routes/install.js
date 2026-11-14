import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const installRouter = Router();

const isWorkerRuntime = typeof globalThis.WebSocketPair !== 'undefined'
  || globalThis.navigator?.userAgent === 'Cloudflare-Workers';
const INSTALL_SCRIPT = isWorkerRuntime
  ? (await import('../../scripts/install.sh')).default
  : readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../scripts/install.sh'),
      'utf8',
    );

const INSTALL_HASH = createHash('sha256').update(INSTALL_SCRIPT).digest('hex');

// The Express server and the Cloudflare Worker both mount this router.
// The Worker loads scripts/install.sh through the wrangler text rule.
function sendInstallScript(_req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Script-SHA256', INSTALL_HASH);
  res.setHeader('Content-Disposition', 'inline; filename="install.sh"');
  res.send(INSTALL_SCRIPT);
}

function sendInstallHash(_req, res) {
  res.json({
    sha256: INSTALL_HASH,
    verify:
      'curl --fail --show-error --silent --location https://clawfix.dev/install.sh --output install-clawfix.sh && shasum -a 256 install-clawfix.sh',
    note: 'Compare the printed hashes exactly before running the script. The same installer is served at /install.sh and /install. Source: https://github.com/arcabotai/clawfix/blob/main/scripts/install.sh',
  });
}

installRouter.get('/install.sh', sendInstallScript);
installRouter.get('/install', sendInstallScript);
installRouter.get('/install.sh.sha256', sendInstallHash);
installRouter.get('/install/sha256', sendInstallHash);

export { INSTALL_HASH, INSTALL_SCRIPT };
