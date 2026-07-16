# Open-source integration research for ClawFix

Research date: 2026-07-16

## Executive recommendation

ClawFix should become an evidence orchestrator, not a second independent copy of OpenClaw's diagnostics.

The recommended stack is:

1. Use OpenClaw's native structured surfaces first: config schema/validation, Doctor lint JSON, policy checks, status, channel probes, and post-upgrade probes.
2. Keep ClawFix's cross-version runtime probes for failures that native Doctor does not observe, such as a dead listener or a competing process on the gateway port.
3. Validate every generated repair with syntax, static analysis, policy checks, and an isolated apply/verify/rollback scenario before presenting it as runnable.
4. Add supply-chain and host-forensics tools as opt-in evidence providers with normalized JSON output.

## Evidence from the Blaxel lab

The reproducible lab uses a 4 GB Blaxel sandbox in `us-pdx-1`, OpenClaw `2026.6.11`, and public ClawFix `0.9.0`.

| Scenario | OpenClaw native result | Public ClawFix result | Design implication |
|---|---|---|---|
| Latest OpenClaw on Blaxel base image | `2026.7.1` installed, then refused Node `24.11.1`; it requires `24.15+` | Version collection loses stderr when the command exits non-zero | Preserve failed command output and detect engine mismatch before other checks |
| Invalid config key | Doctor returned `core/doctor/final-config-validation`, severity `error`, path `gateway` | Missed the invalid key and reported only optimization advice | Import native Doctor/schema findings |
| Dead gateway | Default Doctor lint did not report reachability | Correctly reported a critical dead gateway | Retain ClawFix process/listener probes |
| Port owned by another process | Failed gateway start returned `EADDRINUSE` and the owning PID | Passive ClawFix scan missed the conflict | Add an explicit bind/owner probe and preserve failed-start evidence |
| Healthy foreground gateway | `status --json` reported `gateway.reachable=true` | Reported only three configuration recommendations | Separate failures from optional optimization recommendations |

All injected faults were restored and recovery was verified with a valid config, a running gateway process, and `gateway.reachable=true`. The gateway was then stopped with `npm run lab:stop` so the retained sandbox can become idle between test sessions.

## Integration matrix

### Priority 0: native OpenClaw adapters

| Surface | Value to ClawFix | Integration |
|---|---|---|
| `openclaw config schema` / `config validate` | Canonical, version-matched configuration truth | Capture schema hash and structured validation paths before pattern matching |
| `openclaw doctor --lint --json` | Stable check IDs, severity, paths, and fix hints without writes | Run read-only; skip noisy readiness checks by default; deduplicate against ClawFix findings |
| `openclaw doctor --post-upgrade --json` | Plugin compatibility evidence after upgrades | Make it a required postcondition for upgrade fixes |
| `openclaw policy check --json` | Native security-policy findings | Include in security diagnostics and repair verification |
| `openclaw status --json` and channel probes | Runtime reachability, versions, service state, channel capabilities | Prefer JSON fields over parsing human-readable status text |

OpenClaw documents Doctor lint as read-only and automation-oriented, with structured finding fields and meaningful exit codes. Its config command exposes the canonical live JSON Schema. Sources: [Doctor documentation](https://docs.openclaw.ai/gateway/doctor), [configuration documentation](https://docs.openclaw.ai/gateway/configuration), [policy command](https://docs.openclaw.ai/cli/policy).

### Priority 1: repair validation and regression testing

| Project | Why it fits | Proposed use | License/operational note |
|---|---|---|---|
| [ShellCheck](https://github.com/koalaman/shellcheck) | Mature shell static analysis with JSON output | Reject or downgrade generated fixes with high-confidence shell defects before users see them | GPL-3.0 executable; invoke as an external optional binary rather than embedding code |
| [Bats-core](https://github.com/bats-core/bats-core) | TAP-compliant Bash testing framework | Express apply/verify/rollback postconditions for every known repair and Blaxel fault fixture | MIT-style license; lightweight and suitable for the lab |
| Blaxel sandbox harness | Disposable, stateful microVM for realistic OpenClaw faults | Run a matrix of OpenClaw versions, Node versions, operating environments, and injected failures | Keep user secrets and private workspace files out by default |

The repair gate should be:

`generate -> blocked-command policy -> bash -n -> ShellCheck JSON -> sandbox apply -> OpenClaw validate/Doctor/status -> rollback test -> present to user`

### Priority 1: dependency and secret evidence

| Project | Why it fits | Proposed use | Data boundary |
|---|---|---|---|
| [OSV-Scanner](https://github.com/google/osv-scanner) | Broad lockfile/OS coverage, JSON-friendly vulnerability data, guided remediation, offline database support | Scan OpenClaw, plugins, and ClawFix lockfiles; return advisory IDs and fixed versions | Send package names/versions only when online; offer offline database mode |
| [Gitleaks](https://github.com/gitleaks/gitleaks) | Redacted secret detection with JSON/SARIF output | Scan config, plugin, skill, and workspace trees locally for plaintext credentials missed by key-name redaction | Always use full redaction; upload finding metadata only, never matched secret text |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard) | Repository security-health and supply-chain checks | Score source repositories for third-party OpenClaw plugins/skills before recommending installation | Networked, repository-level check; keep it out of the default host scan |

### Priority 2: advanced host evidence

| Project | Why it fits | Proposed use | Caveat |
|---|---|---|---|
| [osquery](https://github.com/osquery/osquery) | Cross-platform SQL tables for processes, ports, services, hashes, users, and launchd | Replace fragile combinations of `pgrep`, `lsof`, `ss`, and platform-specific parsing with a small read-only query pack | Optional binary; installation weight is too high for the default one-command scan |
| [strace](https://github.com/strace/strace) | Precise Linux syscall evidence | Opt-in deep mode for startup failures, permission errors, missing files, and refused binds | Linux-only and sensitive; require explicit consent and strict duration/output limits |
| [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) | Vendor-neutral logs, metrics, and traces | Instrument hosted ClawFix and long-running monitoring; correlate diagnosis, AI request, repair, and outcome | Better for hosted/monitoring mode than one-shot local repair |

### Architectural reference, not a direct dependency

[HolmesGPT](https://github.com/HolmesGPT/holmesgpt) is a CNCF Sandbox SRE agent with extensible evidence toolsets, server-side filtering, and output transformation to keep large observability payloads out of model context. ClawFix should borrow those design patterns—typed tools, evidence provenance, and context reduction—without embedding its Kubernetes-oriented runtime.

## Tools to defer

### Conftest / OPA

[Conftest](https://github.com/open-policy-agent/conftest) is strong for Rego policy over arbitrary structured config. It should be deferred because OpenClaw already exposes canonical schema validation, Doctor rules, and a policy command. Introduce Conftest only for ClawFix-specific repair postconditions that cannot live upstream.

### Trivy

Trivy covers vulnerabilities, secrets, misconfiguration, licenses, and SBOMs, but much of that overlaps OSV-Scanner, Gitleaks, and Syft. More importantly, Aqua disclosed a critical March 2026 supply-chain incident involving malicious Trivy releases and action tags. If ClawFix later adopts Trivy, require a verified immutable release or source build and never use a floating `latest` artifact. Source: [official Trivy advisory GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).

### SOPS

[SOPS](https://github.com/getsops/sops) is a good encrypted-file editor, but it should remain an optional SecretRef backend rather than a ClawFix prerequisite. ClawFix should first repair users toward OpenClaw's native SecretRef model and avoid taking custody of plaintext secrets.

## Proposed normalized finding format

Every evidence provider should map to a common envelope:

```json
{
  "id": "openclaw:core/doctor/gateway-config",
  "source": "openclaw-doctor",
  "severity": "warning",
  "category": "configuration",
  "summary": "gateway.mode is unset",
  "evidence": [{ "path": "gateway.mode", "observed": "missing" }],
  "confidence": 1,
  "repairability": "guided",
  "fixHint": "Set gateway.mode to local or remote",
  "provenance": {
    "collectorVersion": "2026.6.11",
    "collectedAt": "ISO-8601 timestamp"
  }
}
```

The model should receive this normalized evidence, not raw logs by default. Raw evidence should be retrieved only when a finding requires deeper analysis.

## Recommended implementation order

1. ✅ Add native Doctor, version, config validation, status, and security-audit collectors. Keep policy collection optional because older releases may not expose the plugin command.
2. Change ClawFix results to distinguish `failure`, `warning`, and `optimization` instead of counting all recommendations as issues.
3. Add ShellCheck and Bats to the repair-generation gate and the Blaxel scenario matrix.
4. Add OSV-Scanner and Gitleaks as opt-in local collectors with redacted normalized output.
5. Add provenance, confidence, postconditions, rollback state, and outcome learning to each repair.
6. Add osquery and OpenTelemetry only for advanced/monitoring modes.
