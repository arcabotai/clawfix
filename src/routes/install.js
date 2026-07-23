import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const installRouter = Router();

const INSTALL_SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../scripts/install.sh'),
  'utf8',
);

const INSTALL_HASH = createHash('sha256').update(INSTALL_SCRIPT).digest('hex');

// Serve the installer for download, review, and local execution.
installRouter.get('/install', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Script-SHA256', INSTALL_HASH);
  res.setHeader('Content-Disposition', 'inline; filename="install-clawfix.sh"');
  res.send(INSTALL_SCRIPT);
});

// Installer hash endpoint for verification
installRouter.get('/install/sha256', (req, res) => {
  res.json({
    sha256: INSTALL_HASH,
    verify:
      'curl --fail --show-error --silent --location https://clawfix.dev/install --output install-clawfix.sh && shasum -a 256 install-clawfix.sh',
    note: 'Compare the printed hashes exactly before running the script. Source: https://github.com/arcabotai/clawfix/blob/main/scripts/install.sh',
  });
});

export { INSTALL_HASH, INSTALL_SCRIPT };
