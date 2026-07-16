#!/usr/bin/env node

import { KNOWN_ISSUES } from '../src/known-issues.js';
import { generateFixScript } from '../src/routes/diagnose.js';
import { validateRepairScript } from '../src/repair-validator.js';

const reports = KNOWN_ISSUES.map(issue => ({
  id: issue.id,
  validation: validateRepairScript(issue.fix),
}));
const combinedScript = generateFixScript(
  KNOWN_ISSUES,
  { additionalFixes: 'echo "AI repair validation fixture"' },
  'ci-validation',
);
reports.push({
  id: 'combined-repair-script',
  validation: validateRepairScript(combinedScript),
});

const shellCheckAvailable = reports.every(report => report.validation.shellcheck.available);
if (!shellCheckAvailable) {
  console.error('ShellCheck is required for repair catalog validation.');
  process.exit(2);
}

const failed = reports.filter(report => !report.validation.ok);
const advisoryCount = reports.reduce((total, report) => (
  total + report.validation.shellcheck.findings.filter(finding => finding.level !== 'error').length
), 0);

console.log(JSON.stringify({
  scriptsChecked: reports.length,
  blockers: failed.map(report => ({
    id: report.id,
    blockers: report.validation.blockers,
  })),
  shellcheckAdvisories: advisoryCount,
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
