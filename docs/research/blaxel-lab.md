# Exact-commit Blaxel lab

The lab never provisions from a default branch. Pass the exact 40-character commit to test:

```sh
CLAWFIX_LAB_REF=<current-pr-sha> npm run lab:provision
# or
node scripts/blaxel-lab.mjs provision --ref <current-pr-sha>
```

Provisioning fetches that commit, checks it out detached, and compares `git rev-parse HEAD` with the requested value before installing or running ClawFix. A missing, abbreviated, or mismatched ref fails the run.

After provisioning, run `npm run lab:native` and `npm run lab:scenarios`. Native evidence and scenarios reject command failures, timeouts, empty output, and malformed JSON. Every scenario also verifies its expected issue ID and proves that modified configuration/process state was restored.
