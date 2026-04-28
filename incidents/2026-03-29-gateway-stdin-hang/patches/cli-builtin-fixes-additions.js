/**
 * New builtin fix entries to add to the BUILTIN_FIXES map in cli/bin/clawfix.js
 * These were discovered during the 2026-03-29 gateway incident.
 *
 * Add these entries to the BUILTIN_FIXES object in cli/bin/clawfix.js
 */

// --- FIX 1: Patch LaunchAgent plist to add StandardInPath ---

const launchdMissingStdinPath = {
  'launchd-missing-stdin-path': {
    description: 'Add StandardInPath=/dev/null to the gateway LaunchAgent plist to prevent stdin hangs',
    risk: 'low',
    needsConfig: false,
    needsRestart: true,
    informational: false,
    apply: async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');

      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.gateway.plist');

      if (!fs.existsSync(plistPath)) {
        return { changes: [], warnings: ['LaunchAgent plist not found. Run: openclaw gateway install'] };
      }

      let content = fs.readFileSync(plistPath, 'utf8');

      if (content.includes('StandardInPath')) {
        return { changes: ['StandardInPath already present (no action needed)'] };
      }

      if (!content.includes('StandardOutPath')) {
        return { changes: [], warnings: ['Could not find StandardOutPath anchor in plist -- manual fix needed'] };
      }

      // Backup
      const backupPath = `${plistPath}.bak.${Date.now()}`;
      fs.copyFileSync(plistPath, backupPath);

      // Insert StandardInPath before StandardOutPath
      content = content.replace(
        '<key>StandardOutPath</key>',
        '<key>StandardInPath</key>\n    <string>/dev/null</string>\n    <key>StandardOutPath</key>'
      );

      fs.writeFileSync(plistPath, content);

      return {
        changes: [
          'Added StandardInPath=/dev/null to LaunchAgent plist',
          `Backup saved to ${backupPath}`,
          'Gateway restart required for the fix to take effect',
        ],
      };
    },
  },
};

// --- FIX 2: Version rollback advisory ---

const gatewayRunBrokenFix = {
  'gateway-run-broken-v2026.3.28': {
    description: 'Advisory: OpenClaw v2026.3.28 gateway command is broken. Roll back to v2026.3.13.',
    risk: 'high',
    needsConfig: false,
    needsRestart: true,
    informational: true, // Can't auto-rollback npm packages safely from the CLI
    apply: () => {
      return {
        changes: [],
        warnings: [
          'OpenClaw v2026.3.28 has a bug where the gateway command exits without starting the server.',
          'Roll back manually: npm i -g openclaw@2026.3.13 --no-fund --no-audit',
          'Then run: openclaw gateway install --force',
          'Then apply the launchd-missing-stdin-path fix.',
          'Or use the rollback script: bash incidents/2026-03-29-gateway-stdin-hang/scripts/rollback-version.sh',
        ],
      };
    },
  },
};

// --- FIX 3: Post-update restart failure advisory ---

const postUpdateRestartFix = {
  'post-update-restart-failure': {
    description: 'Advisory: Gateway failed to restart after self-update. Roll back to previous version.',
    risk: 'medium',
    needsConfig: false,
    needsRestart: true,
    informational: true,
    apply: () => {
      return {
        changes: [],
        warnings: [
          'The gateway self-updated but failed to restart.',
          'Check ~/.openclaw/restart-sentinel.json for the previous version.',
          'Roll back: npm i -g openclaw@<previous-version> --no-fund --no-audit',
          'Then reinstall service: openclaw gateway install --force',
          'Consider disabling auto-update or pinning to a stable version.',
        ],
      };
    },
  },
};

export { launchdMissingStdinPath, gatewayRunBrokenFix, postUpdateRestartFix };
